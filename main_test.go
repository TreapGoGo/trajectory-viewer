package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestViewerUsesOnlyTheAuthenticatedAccount(t *testing.T) {
	const viewerOrigin = "https://viewer.example.test"
	const privateToken = "upstream-owner-session"
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/user/email/login":
			writeJSON(w, http.StatusOK, map[string]any{"data": map[string]string{
				"uid": "owner", "name": "Owner", "token": privateToken,
			}})
		case "GET /v1/agent/trajectories":
			if r.Header.Get("token") != privateToken || r.URL.Query().Has("owner_uid") {
				t.Errorf("archive request did not use the authenticated owner")
			}
			writeJSON(w, http.StatusOK, map[string]any{"items": []any{}, "has_more": false})
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	api, _ := url.Parse(backend.URL)
	origin, _ := url.Parse(viewerOrigin)
	handler := newViewer(api, origin).routes()

	request := func(method, path, origin, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Origin", origin)
		// The proxy must discard credentials supplied as browser headers.
		r.Header.Set("token", "different-account")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if got := request("GET", "/api/trajectories", "", "", nil).Code; got != 401 {
		t.Fatalf("unauthenticated list status = %d", got)
	}
	if got := request("POST", "/api/login", "https://foreign.example.test", "{}", nil).Code; got != 403 {
		t.Fatalf("cross-origin login status = %d", got)
	}
	login := request("POST", "/api/login", viewerOrigin, `{"email":"owner@example.test","password":"fixture"}`, nil)
	if login.Code != 200 || strings.Contains(login.Body.String(), privateToken) {
		t.Fatalf("unexpected browser login receipt: %d", login.Code)
	}
	var session *http.Cookie
	for _, cookie := range login.Result().Cookies() {
		if cookie.Name == sessionCookie {
			session = cookie
		}
	}
	if session == nil || session.Value == privateToken || !session.HttpOnly ||
		!session.Secure || session.SameSite != http.SameSiteStrictMode {
		t.Fatal("browser did not receive an isolated secure session cookie")
	}
	if got := request("GET", "/api/trajectories?owner_uid=other", "", "", session).Code; got != 200 {
		t.Fatalf("authenticated list status = %d", got)
	}
	if got := request("POST", "/api/trajectories", viewerOrigin, "{}", session).Code; got != 405 {
		t.Fatalf("archive write status = %d", got)
	}
	if got := request("POST", "/api/logout", viewerOrigin, "{}", session).Code; got != 204 {
		t.Fatalf("logout status = %d", got)
	}
	if got := request("GET", "/api/trajectories", "", "", session).Code; got != 401 {
		t.Fatalf("revoked browser session status = %d", got)
	}
}
