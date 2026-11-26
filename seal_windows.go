//go:build windows

package main

import (
	"errors"
	"syscall"
	"unsafe"
)

var (
	crypt32           = syscall.NewLazyDLL("crypt32.dll")
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	procProtectData   = crypt32.NewProc("CryptProtectData")
	procUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree     = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	size uint32
	data *byte
}

const cryptProtectUIForbidden = 0x1

// seal encrypts with the current Windows user's DPAPI key.
func seal(plain []byte) ([]byte, error) { return dpapi(procProtectData, plain) }

// unseal reverses seal; it only works for the same Windows user.
func unseal(sealed []byte) ([]byte, error) { return dpapi(procUnprotectData, sealed) }

func dpapi(proc *syscall.LazyProc, input []byte) ([]byte, error) {
	if len(input) == 0 {
		return nil, errors.New("empty input")
	}
	in := dataBlob{size: uint32(len(input)), data: &input[0]}
	var out dataBlob
	ok, _, err := proc.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		uintptr(cryptProtectUIForbidden),
		uintptr(unsafe.Pointer(&out)),
	)
	if ok == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.data)))
	return append([]byte(nil), unsafe.Slice(out.data, out.size)...), nil
}
