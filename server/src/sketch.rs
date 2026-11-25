//! Turns an Arduino `.ino` sketch into valid C++.
//!
//! The Arduino IDE does three things to a sketch before handing it to gcc:
//! 1. prepends `#include <Arduino.h>`,
//! 2. generates prototypes for every top-level function so they can be called
//!    before they are defined,
//! 3. emits `#line` directives so compiler errors point at the user's lines.
//!
//! This is a small, dependency-light re-implementation of that step (the
//! official one shells out to ctags).

use regex::Regex;
use std::sync::LazyLock;

static FN_HEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?s)^\s*((?:[A-Za-z_][\w:<>]*[\s\*&]+)+?)([A-Za-z_]\w*)\s*\(([^()]*)\)\s*(const)?\s*$",
    )
    .unwrap()
});

const NOT_TYPES: &[&str] = &[
    "if", "else", "for", "while", "switch", "return", "do", "struct", "class", "enum", "union",
    "namespace", "typedef", "using", "template", "operator", "new", "delete",
];

/// Replace comments, string and char literals with spaces (keeping newlines)
/// so structural scanning is not confused by braces inside them. Preprocessor
/// lines are blanked too.
fn mask(src: &str) -> Vec<u8> {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    let mut line_start = true;
    while i < b.len() {
        let c = b[i];
        if line_start && c == b'#' {
            // Blank the whole preprocessor line (with backslash continuation).
            while i < b.len() && b[i] != b'\n' {
                if b[i] == b'\\' && i + 1 < b.len() && b[i + 1] == b'\n' {
                    out[i] = b' ';
                    i += 2;
                    continue;
                }
                out[i] = b' ';
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            while i < b.len() && !(b[i] == b'*' && i + 1 < b.len() && b[i + 1] == b'/') {
                if b[i] != b'\n' {
                    out[i] = b' ';
                }
                i += 1;
            }
            if i < b.len() {
                out[i] = b' ';
                if i + 1 < b.len() {
                    out[i + 1] = b' ';
                }
                i += 2;
            }
            continue;
        }
        if c == b'"' || c == b'\'' {
            let q = c;
            i += 1;
            while i < b.len() && b[i] != q && b[i] != b'\n' {
                if b[i] == b'\\' {
                    out[i] = b' ';
                    i += 1;
                }
                if i < b.len() {
                    out[i] = b' ';
                }
                i += 1;
            }
            i += 1;
            line_start = false;
            continue;
        }
        if c == b'\n' {
            line_start = true;
        } else if !c.is_ascii_whitespace() {
            line_start = false;
        }
        i += 1;
    }
    out
}

#[derive(Debug, PartialEq)]
pub struct FunctionDef {
    pub prototype: String,
    /// 1-based line on which the definition's text starts.
    pub line: usize,
}

/// Find top-level function definitions.
pub fn find_functions(src: &str) -> Vec<FunctionDef> {
    let m = mask(src);
    let mut defs = Vec::new();
    let mut depth = 0i32;
    let mut paren = 0i32;
    let mut seg_start = 0usize;
    for (i, &c) in m.iter().enumerate() {
        match c {
            b'(' => paren += 1,
            b')' => paren -= 1,
            b'{' => {
                if depth == 0 && paren == 0 {
                    let seg = String::from_utf8_lossy(&m[seg_start..i]).to_string();
                    if let Some(caps) = FN_HEAD.captures(&seg) {
                        let ret = caps[1].split_whitespace().collect::<Vec<_>>().join(" ");
                        let name = &caps[2];
                        let first_word = ret.split([' ', '*', '&']).next().unwrap_or("");
                        let bad = NOT_TYPES.contains(&name)
                            || NOT_TYPES.contains(&first_word)
                            || ret.contains('=');
                        if !bad {
                            let args = caps[3].split_whitespace().collect::<Vec<_>>().join(" ");
                            let konst = caps.get(4).map(|_| " const").unwrap_or("");
                            let lead = seg.len() - seg.trim_start().len();
                            let start = seg_start + lead;
                            let line = 1 + m[..start].iter().filter(|&&b| b == b'\n').count();
                            defs.push(FunctionDef {
                                prototype: format!("{ret} {name}({args}){konst};"),
                                line,
                            });
                        }
                    }
                }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    seg_start = i + 1;
                }
            }
            b';' if depth == 0 && paren == 0 => seg_start = i + 1,
            _ => {}
        }
    }
    defs
}

/// Convert a sketch to a C++ translation unit.
pub fn preprocess(src: &str, file_name: &str) -> String {
    let defs = find_functions(src);
    let lines: Vec<&str> = src.split('\n').collect();
    let mut out = String::with_capacity(src.len() + 256);
    out.push_str("#include <Arduino.h>\n");
    out.push_str(&format!("#line 1 \"{file_name}\"\n"));
    let insert_at = defs.first().map(|d| d.line).unwrap_or(lines.len() + 1);
    for (idx, line) in lines.iter().enumerate() {
        let lineno = idx + 1;
        if lineno == insert_at {
            for d in &defs {
                out.push_str(&d.prototype);
                out.push('\n');
            }
            out.push_str(&format!("#line {lineno} \"{file_name}\"\n"));
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Reject includes that could read files outside the sketch/core (absolute
/// paths or parent traversal). Compiler error messages can echo file
/// contents, so this matters on a shared compile server.
pub fn check_includes(src: &str) -> Result<(), String> {
    static INC: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?m)^\s*#\s*(?:include|include_next|import)\s*[<"]([^>"]*)[>"]"#).unwrap());
    for c in INC.captures_iter(src) {
        let p = &c[1];
        if p.starts_with('/') || p.contains("..") || p.contains('\\') || p.contains(':') {
            return Err(format!("include path not allowed: {p}"));
        }
    }
    if src.contains("__has_include") || src.contains("#embed") || src.contains(".incbin") {
        return Err("file-inclusion directives are not allowed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_simple_functions() {
        let src = "int x = 3;\nvoid setup() {\n}\n\nint add(int a, int b) { return a + b; }\nvoid loop() { if (x) { add(1,2); } }\n";
        let defs = find_functions(src);
        let protos: Vec<_> = defs.iter().map(|d| d.prototype.as_str()).collect();
        assert_eq!(protos, vec!["void setup();", "int add(int a, int b);", "void loop();"]);
        assert_eq!(defs[0].line, 2);
    }

    #[test]
    fn ignores_braces_in_comments_and_strings() {
        let src = "// void fake() {\n/* int nope() { */\nconst char* s = \"{ }\";\nvoid real(char c) {\n  char d = '{';\n}\n";
        let defs = find_functions(src);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].prototype, "void real(char c);");
        assert_eq!(defs[0].line, 4);
    }

    #[test]
    fn skips_structs_and_initializers() {
        let src = "struct P { int x; };\nint arr[] = {1,2,3};\nenum E { A, B };\nP make() { P p; return p; }\n";
        let protos: Vec<_> = find_functions(src).into_iter().map(|d| d.prototype).collect();
        assert_eq!(protos, vec!["P make();"]);
    }

    #[test]
    fn pointer_and_unsigned_return_types() {
        let src = "unsigned long  next_tick(unsigned int  n) {\n return n; }\nconst char *name() { return \"x\"; }\n";
        let protos: Vec<_> = find_functions(src).into_iter().map(|d| d.prototype).collect();
        assert_eq!(protos, vec!["unsigned long next_tick(unsigned int n);", "const char * name();"]);
    }

    #[test]
    fn preprocess_inserts_prototypes_and_line_markers() {
        let src = "#define N 3\n\nvoid loop() { helper(); }\nvoid helper() {}\n";
        let out = preprocess(src, "sketch.ino");
        assert!(out.starts_with("#include <Arduino.h>\n#line 1 \"sketch.ino\"\n#define N 3\n\n"));
        assert!(out.contains("void loop();\nvoid helper();\n#line 3 \"sketch.ino\"\nvoid loop()"));
    }

    #[test]
    fn rejects_dangerous_includes() {
        assert!(check_includes("#include <Servo.h>\n").is_ok());
        assert!(check_includes("#include \"/etc/passwd\"\n").is_err());
        assert!(check_includes("  #  include \"../secret.h\"\n").is_err());
        assert!(check_includes("#if __has_include(\"x\")\n#endif").is_err());
    }
}
