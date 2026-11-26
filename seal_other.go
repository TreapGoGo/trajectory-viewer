//go:build !windows

package main

import "errors"

var errNoSealing = errors.New("session sealing is only implemented for Windows DPAPI")

func seal([]byte) ([]byte, error)   { return nil, errNoSealing }
func unseal([]byte) ([]byte, error) { return nil, errNoSealing }
