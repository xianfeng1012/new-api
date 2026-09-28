package jsplugin

import "testing"

func TestFileReferenceKeepsBareSpellingForFirstFile(t *testing.T) {
	if got := FileReference("image[]", 0); got != "request_file:image[]" {
		t.Fatalf("first file must stay backwards compatible, got %q", got)
	}
	if got := FileReference("image[]", 2); got != "request_file:image[]#2" {
		t.Fatalf("later files must carry their index, got %q", got)
	}
}

func TestParseFileReference(t *testing.T) {
	cases := []struct {
		ref    string
		field  string
		index  int
		ok     bool
	}{
		{"request_file:image[]", "image[]", 0, true},
		{"request_file:image[]#1", "image[]", 1, true},
		{"request_file:image[]#12", "image[]", 12, true},
		{"request_file:input_reference", "input_reference", 0, true},
		{"", "", 0, false},
		{"image[]", "", 0, false},
		{"request_file:", "", 0, false},
		{"request_file:#1", "", 0, false},
		{"request_file:image[]#", "", 0, false},
		{"request_file:image[]#-1", "", 0, false},
		{"request_file:image[]#01", "", 0, false},
		{"request_file:image[]#x", "", 0, false},
	}
	for _, tc := range cases {
		field, index, ok := ParseFileReference(tc.ref)
		if ok != tc.ok || field != tc.field || index != tc.index {
			t.Fatalf("ParseFileReference(%q) = (%q, %d, %v), want (%q, %d, %v)",
				tc.ref, field, index, ok, tc.field, tc.index, tc.ok)
		}
	}
}

func TestFileReferenceRoundTrips(t *testing.T) {
	for _, index := range []int{0, 1, 2, 11, 300} {
		field, parsed, ok := ParseFileReference(FileReference("image[]", index))
		if !ok || field != "image[]" || parsed != index {
			t.Fatalf("round trip failed for index %d: (%q, %d, %v)", index, field, parsed, ok)
		}
	}
}
