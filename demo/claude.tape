# Regenerate:  vhs demo/claude.tape   (run from repo root)
# Real `crew claude` session against demo/config.json -> docs/media/crew-claude.gif
# demo/bin/claude is a recording-only stand-in for the real Claude Code CLI (see that file).
Output docs/media/crew-claude.gif

Set Shell "bash"
Set FontSize 16
Set Width 900
Set Height 780
Set Padding 16
Set TypingSpeed 45ms

Hide
Type 'printf %s "{\"projectsDir\":\"demo/projects\"}" > demo/local.json'
Enter
Type 'export PATH="$PWD/demo/bin:$PATH"'
Enter
Type 'crew() { node bin/crew.js --config demo/config.json "$@"; }'
Enter
Type "clear"
Enter
Show

Type "crew claude checkout-flow"
Sleep 500ms
Enter
Sleep 1800ms

# pick the connected slice we want in the session
Right
Sleep 700ms
Space
Sleep 900ms
Right
Sleep 700ms
Space
Sleep 900ms
Down
Sleep 700ms
Space
Sleep 1200ms

# hand the set to Claude Code (history kept per set)
Enter
Sleep 5500ms
