// trajectory-viewer serves the account-scoped, read-only cloud archive browser.
//
// Workbench additions on top of the original viewer:
//   - the workbench UI (ui/) at /, with the original UI kept under /classic/;
//     -ui serves ui/ from disk instead, for editing without rebuilding,
//   - a one-request "bundle" endpoint with an in-memory archive cache,
//   - with -state: sessions that survive restarts (sealed with Windows DPAPI)
//     and a local key file so command-line tools on this machine can read archives,
//   - a transitional -dev-viewer mode that reuses another local viewer's session.
//
// api/index.js is a stateless port of the same HTTP API for Vercel.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed web/* ui/*
var assets embed.FS

const (
	sessionCookie   = "trajectory_session"
	deviceCookie    = "trajectory_device"
	cliKeyHeader    = "X-Viewer-Key"
	sessionTTL      = 30 * 24 * time.Hour
	maxArchiveReply = 4 << 20
)

type loginResult struct {
	UID   string `json:"uid"`
	Name  string `json:"name"`
	Token string `json:"token"`
}

type browserSession struct {
	name, token string
	expires     time.Time
}

// archiveAuth is how one request reaches the archive: a backend token, or
// (in -dev-viewer mode) the browser cookie of another local viewer.
type archiveAuth struct {
	name, token, cookie string
}

func (a archiveAuth) cacheScope() string {
	sum := sha256.Sum256([]byte(a.token + "\x00" + a.cookie))
	return hex.EncodeToString(sum[:6])
}

type viewer struct {
	upstream *url.URL
	origin   string
	secure   bool
	client   *http.Client

	uiDir     string
	stateDir  string
	cliKey    string
	devViewer *url.URL

	mu        sync.Mutex
	sessions  map[string]browserSession
	lastKey   string
	devCookie string

	cache    *archiveCache
	upstreamSlots chan struct{}
}

func parseOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" ||
		u.Fragment != "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("expected an HTTP(S) origin without a path")
	}
	return u, nil
}

func main() {
	upstream := flag.String("api-origin", os.Getenv("TRAJECTORY_API_ORIGIN"), "Tuple backend origin")
	listen := flag.String("listen", "127.0.0.1:8765", "HTTP bind address")
	public := flag.String("public-origin", "", "external HTTPS origin behind a TLS proxy")
	uiDir := flag.String("ui", "", "serve the workbench UI from this directory (classic UI moves to /classic/)")
	stateDir := flag.String("state", "", "directory for the encrypted session store and the local CLI key")
	devViewer := flag.String("dev-viewer", "", "transitional: read archives through another local viewer's browser session")
	flag.Parse()
	api, err := parseOrigin(*upstream)
	if err != nil {
		log.Fatal("-api-origin: ", err)
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatal("-listen: ", err)
	}
	origin := *public
	if origin == "" {
		if host != "localhost" && !net.ParseIP(host).IsLoopback() {
			log.Fatal("a non-loopback listener requires -public-origin with HTTPS")
		}
		origin = "http://" + *listen
	}
	publicURL, err := parseOrigin(origin)
	if err != nil || (*public != "" && publicURL.Scheme != "https") {
		log.Fatal("-public-origin must be an HTTPS origin")
	}
	v := newViewer(api, publicURL)
	if *uiDir != "" {
		if info, err := os.Stat(*uiDir); err != nil || !info.IsDir() {
			log.Fatal("-ui must be an existing directory")
		}
		v.uiDir = *uiDir
	}
	if *devViewer != "" {
		dev, err := parseOrigin(*devViewer)
		if err != nil {
			log.Fatal("-dev-viewer: ", err)
		}
		v.devViewer = dev
	}
	if *stateDir != "" {
		if err := v.enableState(*stateDir); err != nil {
			log.Fatal("-state: ", err)
		}
	}
	server := &http.Server{
		Addr: *listen, Handler: v.routes(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 2 * time.Minute, IdleTimeout: time.Minute,
	}
	log.Printf("Trajectory viewer: %s", publicURL.String())
	log.Fatal(server.ListenAndServe())
}

func newViewer(upstream, origin *url.URL) *viewer {
	return &viewer{
		upstream: upstream, origin: origin.String(), secure: origin.Scheme == "https",
		client: &http.Client{
			Timeout: 20 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		sessions:  make(map[string]browserSession),
		cache:     newArchiveCache(256 << 20),
		upstreamSlots: make(chan struct{}, 12),
	}
}

// enableState loads persisted sessions and the CLI key from dir, creating both as needed.
func (v *viewer) enableState(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	v.stateDir = dir
	keyPath := filepath.Join(dir, "cli.key")
	if raw, err := os.ReadFile(keyPath); err == nil && len(strings.TrimSpace(string(raw))) == 32 {
		v.cliKey = strings.TrimSpace(string(raw))
	} else {
		v.cliKey = makeKey()
		if err := os.WriteFile(keyPath, []byte(v.cliKey+"\n"), 0o600); err != nil {
			return err
		}
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.loadSessionsLocked(); err != nil {
		log.Printf("session store not loaded: %v", err)
	}
	return nil
}

func (v *viewer) routes() http.Handler {
	inner := http.NewServeMux()
	staticFiles, err := fs.Sub(assets, "web")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(staticFiles)
	for _, path := range []string{"/{$}", "/viewer.css", "/viewer.js", "/trajectory-tools.js"} {
		inner.Handle("GET "+path, files)
	}
	inner.HandleFunc("GET /api/session", v.session)
	inner.HandleFunc("POST /api/login", v.login)
	inner.HandleFunc("POST /api/logout", v.logout)
	inner.HandleFunc("GET /api/trajectories", v.readArchive)
	inner.HandleFunc("GET /api/trajectories/{id}", v.readArchive)
	inner.HandleFunc("GET /api/trajectories/{id}/events", v.readArchive)
	inner.HandleFunc("GET /api/trajectories/{id}/payloads/{payload}", v.readArchive)
	inner.HandleFunc("GET /api/bundle/{id}", v.bundle)

	workbench := http.Handler(nil)
	if v.uiDir != "" {
		workbench = http.FileServer(http.Dir(v.uiDir))
	} else {
		uiFiles, err := fs.Sub(assets, "ui")
		if err != nil {
			panic(err)
		}
		workbench = http.FileServerFS(uiFiles)
	}
	handler := http.NewServeMux()
	classic := http.StripPrefix("/classic", inner)
	handler.Handle("GET /classic/", classic)
	handler.Handle("POST /classic/", classic)
	handler.Handle("GET /api/", inner)
	handler.Handle("POST /api/", inner)
	handler.Handle("GET /", workbench)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodPost && r.Header.Get("Origin") != v.origin {
			fail(w, http.StatusForbidden, "Invalid request origin.")
			return
		}
		handler.ServeHTTP(w, r)
	})
}

func (v *viewer) call(ctx context.Context, method, path string, query url.Values, token string, data any) (int, []byte, error) {
	var body io.Reader
	if data != nil {
		raw, err := json.Marshal(data)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(raw)
	}
	u := v.upstream.JoinPath("v1", path)
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("token", token)
		req.Header.Set("device_flag", "1")
	}
	return v.do(req)
}

func (v *viewer) do(req *http.Request) (int, []byte, error) {
	resp, err := v.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxArchiveReply+1))
	if len(raw) > maxArchiveReply {
		return 0, nil, errors.New("archive response too large")
	}
	return resp.StatusCode, raw, err
}

// devGet reads a path from the -dev-viewer with the browser cookie it issued.
func (v *viewer) devGet(ctx context.Context, path string, query url.Values, cookie string) (int, []byte, error) {
	u := v.devViewer.JoinPath(path)
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cookie", cookie)
	return v.do(req)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func input(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(dst) != nil || decoder.Decode(new(any)) != io.EOF {
		fail(w, http.StatusBadRequest, "Invalid request.")
		return false
	}
	return true
}

func cookieValue(r *http.Request, name string) string {
	cookie, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (v *viewer) cookie(w http.ResponseWriter, name, value string, ttl time.Duration) {
	maxAge := int(ttl.Seconds())
	if ttl == 0 {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: v.secure, SameSite: http.SameSiteStrictMode,
	})
}

func makeKey() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	return hex.EncodeToString(raw[:])
}

// cliAuthorized reports whether the request carries this machine's CLI key.
func (v *viewer) cliAuthorized(r *http.Request) bool {
	got := r.Header.Get(cliKeyHeader)
	return v.cliKey != "" && got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(v.cliKey)) == 1
}

// requestKeyLocked is the session a request speaks for: its browser cookie, or
// for the local CLI the newest login (the backend keeps only the newest web
// token per account, so older sessions are dead anyway).
func (v *viewer) requestKeyLocked(r *http.Request) string {
	key := cookieValue(r, sessionCookie)
	if key == "" && v.cliAuthorized(r) {
		var newest time.Time
		for candidate, session := range v.sessions {
			if session.expires.After(newest) {
				key, newest = candidate, session.expires
			}
		}
	}
	return key
}

func (v *viewer) sessionFor(r *http.Request) (browserSession, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	key := v.requestKeyLocked(r)
	session, ok := v.sessions[key]
	if ok && time.Now().Before(session.expires) {
		v.lastKey = key
		return session, true
	}
	if ok {
		delete(v.sessions, key)
		v.saveSessionsLocked()
	}
	return browserSession{}, false
}

// authFor resolves how this request may read the archive.
func (v *viewer) authFor(r *http.Request) (archiveAuth, bool) {
	if v.devViewer != nil {
		v.mu.Lock()
		defer v.mu.Unlock()
		if cookieValue(r, sessionCookie) != "" {
			v.devCookie = sessionCookie + "=" + cookieValue(r, sessionCookie)
			return archiveAuth{cookie: v.devCookie}, true
		}
		if v.cliAuthorized(r) && v.devCookie != "" {
			return archiveAuth{cookie: v.devCookie}, true
		}
		return archiveAuth{}, false
	}
	session, ok := v.sessionFor(r)
	return archiveAuth{name: session.name, token: session.token}, ok
}

func (v *viewer) forget(r *http.Request) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.sessions, v.requestKeyLocked(r))
	v.saveSessionsLocked()
}

func (v *viewer) session(w http.ResponseWriter, r *http.Request) {
	if v.devViewer != nil {
		auth, ok := v.authFor(r)
		if !ok {
			fail(w, http.StatusUnauthorized, "Sign in to view cloud archives.")
			return
		}
		status, raw, err := v.devGet(r.Context(), "/api/session", nil, auth.cookie)
		if err != nil {
			fail(w, http.StatusBadGateway, "The development viewer is unavailable.")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(raw)
		return
	}
	session, ok := v.sessionFor(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to view cloud archives.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": session.name})
}

func (v *viewer) logout(w http.ResponseWriter, r *http.Request) {
	v.forget(r)
	v.cookie(w, sessionCookie, "", 0)
	w.WriteHeader(http.StatusNoContent)
}

func (v *viewer) pruneExpired() {
	now := time.Now()
	for key, value := range v.sessions {
		if !now.Before(value.expires) {
			delete(v.sessions, key)
		}
	}
}

func (v *viewer) saveSession(w http.ResponseWriter, r *http.Request, data loginResult) {
	key := makeKey()
	v.mu.Lock()
	// A new web login revokes this account's previous web token on the backend,
	// and this local tool serves one person: start from a clean store.
	clear(v.sessions)
	v.sessions[key] = browserSession{data.Name, data.Token, time.Now().Add(sessionTTL)}
	v.lastKey = key
	v.saveSessionsLocked()
	v.mu.Unlock()
	v.cookie(w, sessionCookie, key, sessionTTL)
	writeJSON(w, http.StatusOK, map[string]string{"name": data.Name})
}

func (v *viewer) login(w http.ResponseWriter, r *http.Request) {
	if v.devViewer != nil {
		fail(w, http.StatusNotImplemented, "Sign in on the development viewer instead.")
		return
	}
	var credentials struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !input(w, r, &credentials) {
		return
	}
	credentials.Email = strings.TrimSpace(credentials.Email)
	if credentials.Email == "" || credentials.Password == "" {
		fail(w, http.StatusBadRequest, "Enter your email and password.")
		return
	}
	device := cookieValue(r, deviceCookie)
	if _, err := hex.DecodeString(device); err != nil || len(device) != 32 {
		device = makeKey()
		v.cookie(w, deviceCookie, device, 365*24*time.Hour)
	}
	status, raw, err := v.call(r.Context(), http.MethodPost, "user/email/login", nil, "", map[string]any{
		"email": credentials.Email, "password": credentials.Password, "flag": 1,
		"device": map[string]string{"device_id": device, "device_name": "Trajectory viewer", "device_model": "Web"},
	})
	if err != nil || status >= 500 {
		fail(w, http.StatusBadGateway, "The Tuple sign-in service is unavailable.")
		return
	}
	var result struct {
		Data loginResult `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		fail(w, http.StatusBadGateway, "Unexpected sign-in response.")
		return
	}
	if status != http.StatusOK || result.Data.UID == "" || result.Data.Token == "" {
		fail(w, http.StatusUnauthorized, "Tuple could not sign you in. Check your credentials and try again.")
		return
	}
	v.saveSession(w, r, result.Data)
}

func validArchiveID(id string) bool {
	return id != "" && len(id) <= 160 && !strings.ContainsFunc(id, func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') &&
			(r < '0' || r > '9') && !strings.ContainsRune("-_:.", r)
	}) && id != "." && id != ".."
}

func (v *viewer) readArchive(w http.ResponseWriter, r *http.Request) {
	auth, ok := v.authFor(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to view cloud archives.")
		return
	}
	sub := ""
	if id := r.PathValue("id"); id != "" {
		if !validArchiveID(id) {
			fail(w, http.StatusBadRequest, "Invalid archive ID.")
			return
		}
		sub += "/" + id
	}
	switch {
	case r.PathValue("payload") != "":
		id := r.PathValue("payload")
		if !validArchiveID(id) {
			fail(w, http.StatusBadRequest, "Invalid content ID.")
			return
		}
		sub += "/payloads/" + id
	case strings.HasSuffix(r.Pattern, "/events"):
		sub += "/events"
	}
	query := url.Values{}
	for _, key := range []string{"cursor", "status", "agent_uid", "invocation_id", "from_at_ms", "to_at_ms", "limit", "after_seq", "children_after", "snapshot_seq"} {
		if value := r.URL.Query().Get(key); value != "" {
			query.Set(key, value)
		}
	}
	status, raw, err := v.archiveGet(r.Context(), auth, sub, query, r.URL.Query().Get("fresh") == "1")
	v.writeArchive(w, r, status, raw, err)
}

func (v *viewer) writeArchive(w http.ResponseWriter, r *http.Request, status int, raw []byte, err error) {
	switch {
	case err != nil || status >= 500:
		fail(w, http.StatusBadGateway, "The cloud archive service is unavailable.")
	case status == http.StatusUnauthorized:
		if v.devViewer == nil {
			v.forget(r)
			v.cookie(w, sessionCookie, "", 0)
		}
		fail(w, status, "Your sign-in expired. Sign in again.")
	case status == http.StatusForbidden || status == http.StatusNotFound:
		fail(w, status, "This archive is unavailable to your account.")
	case status == http.StatusBadRequest:
		fail(w, status, "The cloud archive rejected these filters.")
	case status != http.StatusOK || !json.Valid(raw):
		fail(w, http.StatusBadGateway, "Unexpected response from the cloud archive.")
	default:
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(raw)
	}
}
