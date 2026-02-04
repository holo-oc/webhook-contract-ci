# Demo tape for https://github.com/charmbracelet/vhs
#
# Generates a short terminal GIF that shows the CLI detecting breaking changes.
#
# Usage (local):
#   brew install vhs   # or see https://github.com/charmbracelet/vhs
#   cd examples/example-repo
#   npm ci
#   vhs ../vhs/wcci.tape
#
# Output defaults to ./wcci-demo.gif

Output "wcci-demo.gif"

Set FontSize 18
Set Width 900
Set Height 520
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Type "cd examples/example-repo"
Enter

Type "npm ci"
Enter
Sleep 2s

Type "node ../../dist/cli.js diff --base schemas/webhook.schema.json --next samples/webhook.payload.breaking.json --show-nonbreaking"
Enter
Sleep 2s

Type "echo $?"
Enter
Sleep 2s
