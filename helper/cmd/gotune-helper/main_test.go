package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectStructProducesSafeCommentPreservingRewrite(t *testing.T) {
	filename := writeGoFile(t, `package sample

type layout struct {
	// ready stays with the bool.
	ready bool
	count int64
	retry bool
	name string
}
`)
	result, err := inspectStruct(filename, "layout")
	if err != nil {
		t.Fatal(err)
	}
	if result.Size != 40 || result.OptimizedSize != 32 {
		t.Fatalf("unexpected sizes: %d -> %d", result.Size, result.OptimizedSize)
	}
	if !result.SafeToApply {
		t.Fatalf("expected safe rewrite, got reasons %v", result.SafetyReasons)
	}
	if !strings.Contains(result.OptimizedSource, "// ready stays with the bool.\n\tready bool") {
		t.Fatalf("field comment was not preserved:\n%s", result.OptimizedSource)
	}
}

func TestInspectStructRejectsUnkeyedLiterals(t *testing.T) {
	filename := writeGoFile(t, `package sample

type layout struct {
	ready bool
	count int64
}

var value = layout{true, 1}
`)
	result, err := inspectStruct(filename, "layout")
	if err != nil {
		t.Fatal(err)
	}
	if result.SafeToApply {
		t.Fatal("unkeyed literals must prevent automatic field reordering")
	}
	if !containsReason(result.SafetyReasons, "unkeyed struct literal") {
		t.Fatalf("missing unkeyed literal reason: %v", result.SafetyReasons)
	}
}

func writeGoFile(t *testing.T, source string) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "sample.go")
	if err := os.WriteFile(filename, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func containsReason(reasons []string, part string) bool {
	for _, reason := range reasons {
		if strings.Contains(reason, part) {
			return true
		}
	}
	return false
}
