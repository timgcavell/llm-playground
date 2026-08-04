package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	maxKeyChars   = 128
	maxValueChars = 8_000
	maxKeysListed = 100
)

// MemoryStore is the notes for one identity. Keys are namespaced by that
// identity, so one person's notes are unreachable from another's session even
// though they share a namespace.
type MemoryStore struct {
	KV    KVStore
	Owner string
}

// KVStore is the slice of the key-value store these tools need — declared
// here, by the consumer, so the package depends on a behaviour rather than on
// Cloudflare, and so a test can substitute a map.
//
// Get reports absence with a bool rather than a sentinel error: sharing an
// ErrNotFound across packages makes "the lookup failed" and "there is nothing
// there" easy to conflate, and here that would read as a deleted note.
type KVStore interface {
	Get(ctx context.Context, key string) (value []byte, found bool, err error)
	Put(ctx context.Context, key string, value []byte) error
	Delete(ctx context.Context, key string) error
	List(ctx context.Context, prefix string, limit int) ([]string, error)
}

func (m *MemoryStore) key(name string) string {
	return fmt.Sprintf("mem:%s:%s", m.Owner, name)
}

func (m *MemoryStore) prefix() string {
	return fmt.Sprintf("mem:%s:", m.Owner)
}

// keyPattern keeps note names to something predictable. ":" is excluded so the
// owner prefix cannot be forged from the key side.
var keyPattern = regexp.MustCompile(`^[A-Za-z0-9 ._\-/]+$`)

const keyRule = "Keys may contain letters, numbers, spaces, and . _ - / and be at most 128 characters."

func normalizeKey(raw string) (string, bool) {
	key := trimSpace(raw)
	if key == "" || len(key) > maxKeyChars || !keyPattern.MatchString(key) {
		return "", false
	}
	return key, true
}

type memoryRecord struct {
	Value   string `json:"value"`
	SavedAt string `json:"savedAt"`
}

func hasMemory(env *Env) bool { return env.Memory != nil }

func saveMemoryTool() *Tool {
	return &Tool{
		Name:      "save_memory",
		Scope:     ScopeMemoryWrite,
		Available: hasMemory,
		Summarize: func(input map[string]any) string { return stringArg(input, "key") },
		Describe: func(*Env) (string, map[string]any) {
			return "Store a piece of text under a key so it can be read back in a later " +
					"conversation. Use it for things worth remembering across sessions, such as " +
					"preferences or notes. Saving to a key that already exists replaces its contents.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"key":   map[string]any{"type": "string", "description": "A short name for this note. " + keyRule},
						"value": map[string]any{"type": "string", "description": "The text to store."},
					},
					"required": []string{"key", "value"},
				}
		},
		Run: func(ctx context.Context, input map[string]any, env *Env) Result {
			key, valid := normalizeKey(stringArg(input, "key"))
			if !valid {
				return refuse("Refused: invalid key. %s", keyRule)
			}
			value, _ := input["value"].(string)
			if trimSpace(value) == "" {
				return refuse("Refused: no value was provided.")
			}
			if len(value) > maxValueChars {
				return refuse("Refused: values are limited to %d characters.", maxValueChars)
			}

			existing, err := readRecord(ctx, env.Memory, key)
			if err != nil {
				return refuse("Could not read the existing note: %v", err)
			}

			encoded, err := json.Marshal(memoryRecord{Value: value, SavedAt: time.Now().UTC().Format(time.RFC3339)})
			if err != nil {
				return refuse("Could not encode the note: %v", err)
			}
			if err := env.Memory.KV.Put(ctx, env.Memory.key(key), encoded); err != nil {
				return refuse("Could not save the note: %v", err)
			}

			// Say plainly when a write replaced something, so an accidental
			// overwrite is visible in the transcript rather than silent.
			if existing != nil {
				return ok("Replaced %q (was %d characters, now %d).", key, len(existing.Value), len(value))
			}
			return ok("Saved %q (%d characters).", key, len(value))
		},
	}
}

func readMemoryTool() *Tool {
	return &Tool{
		Name:      "read_memory",
		Scope:     ScopeMemoryRead,
		Available: hasMemory,
		Summarize: func(input map[string]any) string { return stringArg(input, "key") },
		Describe: func(*Env) (string, map[string]any) {
			return "Read back the text stored under a key. Use list_memories first if you do not " +
					"already know the key.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"key": map[string]any{"type": "string", "description": "The key to read."},
					},
					"required": []string{"key"},
				}
		},
		Run: func(ctx context.Context, input map[string]any, env *Env) Result {
			key, valid := normalizeKey(stringArg(input, "key"))
			if !valid {
				return refuse("Refused: invalid key. %s", keyRule)
			}
			record, err := readRecord(ctx, env.Memory, key)
			if err != nil {
				return refuse("Could not read the note: %v", err)
			}
			if record == nil {
				// Not an error: "nothing stored" is a legitimate answer.
				return ok("Nothing is stored under %q.", key)
			}
			return ok("%s:\n\n%s", key, record.Value)
		},
	}
}

func listMemoriesTool() *Tool {
	return &Tool{
		Name:      "list_memories",
		Scope:     ScopeMemoryRead,
		Available: hasMemory,
		Summarize: func(map[string]any) string { return "" },
		Describe: func(*Env) (string, map[string]any) {
			return "List the keys that currently have something stored under them.",
				map[string]any{"type": "object", "properties": map[string]any{}, "required": []string{}}
		},
		Run: func(ctx context.Context, _ map[string]any, env *Env) Result {
			keys, err := env.Memory.KV.List(ctx, env.Memory.prefix(), maxKeysListed)
			if err != nil {
				return refuse("Could not list notes: %v", err)
			}
			if len(keys) == 0 {
				return ok("Nothing is stored yet.")
			}
			names := make([]string, 0, len(keys))
			for _, key := range keys {
				names = append(names, strings.TrimPrefix(key, env.Memory.prefix()))
			}
			sort.Strings(names)

			var listing strings.Builder
			listing.WriteString("Stored keys:")
			for _, name := range names {
				fmt.Fprintf(&listing, "\n- %s", name)
			}
			if len(names) >= maxKeysListed {
				fmt.Fprintf(&listing, "\n\n[showing the first %d]", maxKeysListed)
			}
			return ok("%s", listing.String())
		},
	}
}

func deleteMemoryTool() *Tool {
	return &Tool{
		Name:  "delete_memory",
		Scope: ScopeMemoryWrite,
		// Irreversible, so ask first where the transport can carry an answer.
		NeedsApproval: true,
		Available:     hasMemory,
		Summarize:     func(input map[string]any) string { return stringArg(input, "key") },
		Describe: func(*Env) (string, map[string]any) {
			return "Delete the text stored under one key. This cannot be undone, and it takes a " +
					"single exact key — there is no way to delete several at once.",
				map[string]any{
					"type": "object",
					"properties": map[string]any{
						"key": map[string]any{"type": "string", "description": "The exact key to delete."},
					},
					"required": []string{"key"},
				}
		},
		Run: func(ctx context.Context, input map[string]any, env *Env) Result {
			key, valid := normalizeKey(stringArg(input, "key"))
			if !valid {
				return refuse("Refused: invalid key. %s", keyRule)
			}
			record, err := readRecord(ctx, env.Memory, key)
			if err != nil {
				return refuse("Could not read the note: %v", err)
			}
			if record == nil {
				return ok("Nothing was stored under %q.", key)
			}
			if err := env.Memory.KV.Delete(ctx, env.Memory.key(key)); err != nil {
				return refuse("Could not delete the note: %v", err)
			}
			return ok("Deleted %q (%d characters).", key, len(record.Value))
		},
	}
}

func readRecord(ctx context.Context, memory *MemoryStore, key string) (*memoryRecord, error) {
	raw, found, err := memory.KV.Get(ctx, memory.key(key))
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	var record memoryRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		// A value written before this encoding, or by hand.
		return &memoryRecord{Value: string(raw)}, nil
	}
	return &record, nil
}
