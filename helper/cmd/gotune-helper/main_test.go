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

func TestInspectStructUsesActiveBuildFiles(t *testing.T) {
	directory := t.TempDir()
	writeTestFile(t, filepath.Join(directory, "go.mod"), "module example.com/layout\n\ngo 1.19\n")
	filename := filepath.Join(directory, "sample.go")
	writeTestFile(t, filename, `package sample

type layout struct {
	ready bool
	count int64
}
`)
	writeTestFile(t, filepath.Join(directory, "excluded.go"), `//go:build never

package sample

type layout struct{ duplicate string }
`)
	result, err := inspectStruct(filename, "layout")
	if err != nil {
		t.Fatal(err)
	}
	if result.Size != 16 {
		t.Fatalf("unexpected active layout size: %d", result.Size)
	}
}

func TestInspectStructResolvesModuleImports(t *testing.T) {
	directory := t.TempDir()
	writeTestFile(t, filepath.Join(directory, "go.mod"), "module example.com/layout\n\ngo 1.19\n")
	writeTestFile(t, filepath.Join(directory, "dep", "value.go"), `package dep

type Value struct{ Count int64 }
`)
	filename := filepath.Join(directory, "sample.go")
	writeTestFile(t, filename, `package sample

import "example.com/layout/dep"

type layout struct {
	ready bool
	value dep.Value
	retry bool
}
`)
	result, err := inspectStruct(filename, "layout")
	if err != nil {
		t.Fatal(err)
	}
	if result.Size != 24 || result.OptimizedSize != 16 {
		t.Fatalf("unexpected imported layout sizes: %d -> %d", result.Size, result.OptimizedSize)
	}
	if result.Fields[1].Type != "dep.Value" {
		t.Fatalf("module type was not resolved: %s", result.Fields[1].Type)
	}
}

func writeGoFile(t *testing.T, source string) string {
	t.Helper()
	directory := t.TempDir()
	writeTestFile(t, filepath.Join(directory, "go.mod"), "module example.com/sample\n\ngo 1.19\n")
	filename := filepath.Join(directory, "sample.go")
	writeTestFile(t, filename, source)
	return filename
}

func writeTestFile(t *testing.T, filename, source string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
}

func containsReason(reasons []string, part string) bool {
	for _, reason := range reasons {
		if strings.Contains(reason, part) {
			return true
		}
	}
	return false
}
