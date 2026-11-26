package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func fakeArchive(t *testing.T, token string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/user/email/login" {
			writeJSON(w, http.StatusOK, map[string]any{"data": map[string]string{"uid": "owner", "name": "Owner", "token": token}})
			return
		}
		if r.Header.Get("token") != token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch path := strings.TrimPrefix(r.URL.Path, "/v1/agent/trajectories"); {
		case path == "":
			writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "has_more": false})
		case path == "/parent":
			writeJSON(w, http.StatusOK, map[string]any{"run": map[string]string{"id": "parent"}, "children": []string{"child"}})
		case path == "/child":
			writeJSON(w, http.StatusOK, map[string]any{"run": map[string]string{"id": "child"}, "children": []string{}})
		case strings.HasSuffix(path, "/events"):
			run := strings.Split(path, "/")[1]
			after := r.URL.Query().Get("after_seq")
			if run == "parent" && after == "" {
				writeJSON(w, http.StatusOK, map[string]any{"events": []any{
					map[string]any{"seq": 1, "kind": "run.accepted", "payload_id": "parent:1"},
				}, "has_more": true, "next_seq": 1})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"events": []any{
				map[string]any{"seq": 2, "kind": "run.finished", "payload_id": run + ":2"},
			}, "has_more": false, "next_seq": 2})
		case strings.Contains(path, "/payloads/"):
			id := path[strings.LastIndex(path, "/")+1:]
			writeJSON(w, http.StatusOK, map[string]any{"payload": map[string]any{"id": id, "value": map[string]string{"echo": id}}})
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestWorkbenchUIRoutes(t *testing.T) {
	api, _ := url.Parse("http://127.0.0.1:1")
	origin, _ := url.Parse("http://127.0.0.1:8765")
	v := newViewer(api, origin)
	v.uiDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(v.uiDir, "index.html"), []byte("workbench"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := v.routes()
	for path, want := range map[string]int{"/": 200, "/classic/": 200, "/classic/viewer.js": 200, "/api/session": 401, "/classic/api/session": 401} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != want {
			t.Errorf("GET %s = %d, want %d", path, w.Code, want)
		}
	}

	// Without -ui the embedded workbench is served at / and the original UI at /classic/.
	embedded := newViewer(api, origin).routes()
	for path, marker := range map[string]string{"/": "app.js", "/digest.js": "digestBundle", "/classic/": "viewer.js"} {
		w := httptest.NewRecorder()
		embedded.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), marker) {
			t.Errorf("embedded GET %s = %d, missing %q", path, w.Code, marker)
		}
	}
}

func TestSessionsSurviveRestartAndCLIKeyReadsArchive(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("session sealing uses DPAPI")
	}
	backend := fakeArchive(t, "upstream-token")
	defer backend.Close()
	api, _ := url.Parse(backend.URL)
	origin, _ := url.Parse("http://127.0.0.1:8765")
	dir := t.TempDir()

	first := newViewer(api, origin)
	if err := first.enableState(dir); err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"email":"a@b.test","password":"x"}`))
	login.Header.Set("Origin", "http://127.0.0.1:8765")
	recorder := httptest.NewRecorder()
	first.routes().ServeHTTP(recorder, login)
	if recorder.Code != 200 {
		t.Fatalf("login status %d", recorder.Code)
	}
	var cookie *http.Cookie
	for _, c := range recorder.Result().Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	sealed, err := os.ReadFile(filepath.Join(dir, "sessions.dat"))
	if err != nil || strings.Contains(string(sealed), "upstream-token") {
		t.Fatalf("session store missing or not sealed: %v", err)
	}

	second := newViewer(api, origin) // a restarted process
	if err := second.enableState(dir); err != nil {
		t.Fatal(err)
	}
	handler := second.routes()
	get := func(path string, prepare func(*http.Request)) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		prepare(r)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if got := get("/api/trajectories", func(r *http.Request) { r.AddCookie(cookie) }).Code; got != 200 {
		t.Fatalf("restored browser session status %d", got)
	}
	key, _ := os.ReadFile(filepath.Join(dir, "cli.key"))
	if got := get("/api/trajectories", func(r *http.Request) { r.Header.Set(cliKeyHeader, strings.TrimSpace(string(key))) }).Code; got != 200 {
		t.Fatalf("CLI key status %d", got)
	}
	if got := get("/api/trajectories", func(r *http.Request) { r.Header.Set(cliKeyHeader, "wrong") }).Code; got != 401 {
		t.Fatalf("wrong CLI key status %d", got)
	}

	w := get("/api/bundle/parent", func(r *http.Request) { r.AddCookie(cookie) })
	if w.Code != 200 {
		t.Fatalf("bundle status %d: %s", w.Code, w.Body)
	}
	var bundle runBundle
	if err := json.Unmarshal(w.Body.Bytes(), &bundle); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Events) != 2 || len(bundle.Payloads) != 2 || len(bundle.Children) != 1 ||
		len(bundle.Children[0].Payloads) != 1 || !strings.Contains(string(bundle.Payloads["parent:2"]), `"echo":"parent:2"`) {
		t.Fatalf("unexpected bundle: %s", fmt.Sprint(w.Body.String()))
	}

	// Logging in again (e.g. a double submit) leaves exactly one session behind.
	again := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"email":"a@b.test","password":"x"}`))
	again.Header.Set("Origin", "http://127.0.0.1:8765")
	again.AddCookie(cookie)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, again)
	for _, c := range recorder.Result().Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if len(second.sessions) != 1 {
		t.Fatalf("sessions after a second login = %d, want 1", len(second.sessions))
	}
	if got := get("/api/trajectories", func(r *http.Request) { r.Header.Set(cliKeyHeader, strings.TrimSpace(string(key))) }).Code; got != 200 {
		t.Fatalf("CLI key after re-login status %d", got)
	}

	logout := httptest.NewRequest("POST", "/api/logout", nil)
	logout.Header.Set("Origin", "http://127.0.0.1:8765")
	logout.AddCookie(cookie)
	handler.ServeHTTP(httptest.NewRecorder(), logout)
	if _, err := os.Stat(filepath.Join(dir, "sessions.dat")); !os.IsNotExist(err) {
		t.Fatalf("logout kept the session store: %v", err)
	}
}
