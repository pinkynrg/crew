package crew

// Insertion-ordered JSON — config files round-trip through OM so `crew list`, the editor's
// left list, and rewritten configs keep the author's key ordering (a plain map would randomize
// it run to run). Output shape: 2-space indent, no HTML escaping, numbers verbatim.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type OM struct {
	keys []string
	m    map[string]any
}

func NewOM() *OM { return &OM{m: map[string]any{}} }

func (o *OM) Keys() []string { return append([]string(nil), o.keys...) }
func (o *OM) Len() int       { return len(o.keys) }
func (o *OM) Has(k string) bool {
	_, ok := o.m[k]
	return ok
}
func (o *OM) Get(k string) any { return o.m[k] }
func (o *OM) Set(k string, v any) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}
func (o *OM) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

// typed getters (nil-safe on a nil receiver)
func (o *OM) GetOM(k string) *OM {
	if o == nil {
		return nil
	}
	if v, ok := o.m[k].(*OM); ok {
		return v
	}
	return nil
}
func (o *OM) GetStr(k string) string {
	if o == nil {
		return ""
	}
	if v, ok := o.m[k].(string); ok {
		return v
	}
	return ""
}
func (o *OM) GetArr(k string) []any {
	if o == nil {
		return nil
	}
	if v, ok := o.m[k].([]any); ok {
		return v
	}
	return nil
}

func StrArr(v any) ([]string, bool) {
	arr, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, len(arr))
	for i, x := range arr {
		s, ok := x.(string)
		if !ok {
			return nil, false
		}
		out[i] = s
	}
	return out, true
}

func IsObj(v any) bool { _, ok := v.(*OM); return ok }

// ---- decode ----

func ParseJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	// reject trailing garbage
	if dec.More() {
		return nil, fmt.Errorf("unexpected trailing data")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			om := NewOM()
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, _ := kt.(string)
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				om.Set(k, v)
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return om, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return tok, nil // string, json.Number, bool, nil
	}
}

// ---- encode (Node JSON.stringify(x, null, 2) shape: 2-space indent, no HTML escaping) ----

func MarshalJSON(v any) string {
	var b strings.Builder
	writeValue(&b, v, 0)
	return b.String()
}

func writeValue(b *strings.Builder, v any, depth int) {
	switch t := v.(type) {
	case *OM:
		if t == nil || len(t.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, k := range t.keys {
			b.WriteString(strings.Repeat("  ", depth+1))
			b.WriteString(scalarJSON(k))
			b.WriteString(": ")
			writeValue(b, t.m[k], depth+1)
			if i < len(t.keys)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(strings.Repeat("  ", depth))
		b.WriteString("}")
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, x := range t {
			b.WriteString(strings.Repeat("  ", depth+1))
			writeValue(b, x, depth+1)
			if i < len(t)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(strings.Repeat("  ", depth))
		b.WriteString("]")
	case json.Number:
		b.WriteString(t.String())
	case nil:
		b.WriteString("null")
	case string:
		b.WriteString(scalarJSON(t))
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case int:
		fmt.Fprintf(b, "%d", t)
	case float64:
		b.WriteString(scalarJSON(t))
	default:
		b.WriteString(scalarJSON(v))
	}
}

func scalarJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimRight(buf.String(), "\n")
}
