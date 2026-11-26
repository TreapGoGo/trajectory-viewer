package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"
)

// Browser sessions persist across restarts in <state>/sessions.dat, sealed with
// the OS user's data-protection key (DPAPI on Windows). Nothing is written when
// sealing is unavailable, so a plaintext token never reaches the disk.

type storedSession struct {
	Name    string    `json:"name"`
	Token   string    `json:"token"`
	Expires time.Time `json:"expires"`
}

type sessionFile struct {
	Last     string                   `json:"last"`
	Sessions map[string]storedSession `json:"sessions"`
}

func (v *viewer) sessionPath() string {
	if v.stateDir == "" {
		return ""
	}
	return filepath.Join(v.stateDir, "sessions.dat")
}

func (v *viewer) loadSessionsLocked() error {
	path := v.sessionPath()
	if path == "" {
		return nil
	}
	sealed, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	plain, err := unseal(sealed)
	if err != nil {
		return err
	}
	var file sessionFile
	if err := json.Unmarshal(plain, &file); err != nil {
		return err
	}
	now := time.Now()
	for key, stored := range file.Sessions {
		if now.Before(stored.Expires) && stored.Token != "" {
			v.sessions[key] = browserSession{stored.Name, stored.Token, stored.Expires}
		}
	}
	if _, ok := v.sessions[file.Last]; ok {
		v.lastKey = file.Last
	}
	log.Printf("restored %d session(s)", len(v.sessions))
	return nil
}

func (v *viewer) saveSessionsLocked() {
	path := v.sessionPath()
	if path == "" {
		return
	}
	file := sessionFile{Last: v.lastKey, Sessions: map[string]storedSession{}}
	for key, session := range v.sessions {
		file.Sessions[key] = storedSession{session.name, session.token, session.expires}
	}
	if len(file.Sessions) == 0 {
		_ = os.Remove(path)
		return
	}
	plain, err := json.Marshal(file)
	if err != nil {
		log.Printf("session store not saved: %v", err)
		return
	}
	sealed, err := seal(plain)
	if err != nil {
		log.Printf("session store not saved: %v", err)
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, sealed, 0o600); err != nil {
		log.Printf("session store not saved: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		log.Printf("session store not saved: %v", err)
	}
}
