// trajectory-viewer serves the account-scoped, read-only cloud archive browser.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var assets embed.FS

const (
	sessionCookie   = "trajectory_session"
	deviceCookie    = "trajectory_device"
	sessionTTL      = 8 * time.Hour
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

type viewer struct {
	upstream *url.URL
	origin   string
	secure   bool
	client   *http.Client

	mu       sync.Mutex
	sessions map[string]browserSession
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
	server := &http.Server{
		Addr: *listen, Handler: v.routes(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: time.Minute,
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
		sessions: make(map[string]browserSession),
	}
}

func (v *viewer) routes() http.Handler {
	mux := http.NewServeMux()
	staticFiles, err := fs.Sub(assets, "web")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(staticFiles)
	for _, path := range []string{"/{$}", "/viewer.css", "/viewer.js", "/trajectory-tools.js"} {
		mux.Handle("GET "+path, files)
	}
	mux.HandleFunc("GET /api/session", v.session)
	mux.HandleFunc("POST /api/login", v.login)
	mux.HandleFunc("POST /api/logout", v.logout)
	mux.HandleFunc("GET /api/trajectories", v.readArchive)
	mux.HandleFunc("GET /api/trajectories/{id}", v.readArchive)
	mux.HandleFunc("GET /api/trajectories/{id}/events", v.readArchive)
	mux.HandleFunc("GET /api/trajectories/{id}/payloads/{payload}", v.readArchive)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodPost && r.Header.Get("Origin") != v.origin {
			fail(w, http.StatusForbidden, "Invalid request origin.")
			return
		}
		mux.ServeHTTP(w, r)
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

func (v *viewer) sessionFor(r *http.Request) (browserSession, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	key := cookieValue(r, sessionCookie)
	session, ok := v.sessions[key]
	if ok && time.Now().Before(session.expires) {
		return session, true
	}
	delete(v.sessions, key)
	return browserSession{}, false
}

func (v *viewer) forget(r *http.Request) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.sessions, cookieValue(r, sessionCookie))
}

func (v *viewer) session(w http.ResponseWriter, r *http.Request) {
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
	v.forget(r)
	key := makeKey()
	v.mu.Lock()
	v.pruneExpired()
	v.sessions[key] = browserSession{data.Name, data.Token, time.Now().Add(sessionTTL)}
	v.mu.Unlock()
	v.cookie(w, sessionCookie, key, sessionTTL)
	writeJSON(w, http.StatusOK, map[string]string{"name": data.Name})
}

func (v *viewer) login(w http.ResponseWriter, r *http.Request) {
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
	session, ok := v.sessionFor(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to view cloud archives.")
		return
	}
	const base = "agent/trajectories"
	path := base
	if id := r.PathValue("id"); id != "" {
		if !validArchiveID(id) {
			fail(w, http.StatusBadRequest, "Invalid archive ID.")
			return
		}
		path += "/" + id
	}
	switch {
	case r.PathValue("payload") != "":
		id := r.PathValue("payload")
		if !validArchiveID(id) {
			fail(w, http.StatusBadRequest, "Invalid content ID.")
			return
		}
		path += "/payloads/" + id
	case r.Pattern == "GET /api/trajectories/{id}/events":
		path += "/events"
	}
	query := url.Values{}
	for _, key := range []string{"cursor", "status", "agent_uid", "invocation_id", "from_at_ms", "to_at_ms", "limit", "after_seq", "children_after", "snapshot_seq"} {
		if value := r.URL.Query().Get(key); value != "" {
			query.Set(key, value)
		}
	}
	status, raw, err := v.call(r.Context(), http.MethodGet, path, query, session.token, nil)
	switch {
	case err != nil || status >= 500:
		fail(w, http.StatusBadGateway, "The cloud archive service is unavailable.")
	case status == http.StatusUnauthorized:
		v.forget(r)
		v.cookie(w, sessionCookie, "", 0)
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
