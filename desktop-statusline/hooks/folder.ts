// Opening a folder in Explorer from the hooks module. The engine starts a
// command with its window hidden, and Explorer started so opens the folder in a
// window it never shows; a window a background process opens also stays behind
// the app, out of sight. So Windows runs a PowerShell script that opens it
// through `start`, which shows it, waits for it, and brings it to the front.

/** The variable the script reads the folder from, so the path is never quoted into it. */
export const FOLDER_VARIABLE = 'DESKTOP_STATUSLINE_FOLDER'

/**
 * Shows the folder in Explorer, in front: the window already open on it, else
 * a new one. Windows lets only the foreground's thread raise a window, so the
 * script joins that thread's input for the moment it raises its own.
 */
export const SHOW_FOLDER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$folder = $env:${FOLDER_VARIABLE}`,
  "Add-Type @'",
  'using System; using System.Runtime.InteropServices;',
  'public static class Front {',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  public static void Raise(IntPtr h) {',
  '    uint them = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);',
  '    uint me = GetCurrentThreadId();',
  '    AttachThreadInput(me, them, true);',
  '    if (IsIconic(h)) ShowWindow(h, 9);',
  '    BringWindowToTop(h);',
  '    SetForegroundWindow(h);',
  '    AttachThreadInput(me, them, false);',
  '  }',
  '}',
  "'@",
  '$shell = New-Object -ComObject Shell.Application',
  '$url = ([Uri]$folder).AbsoluteUri',
  // Only a shown window: Explorer shows a new one once it has opened the folder,
  // and raising it before then leaves it hidden.
  '$find = { @($shell.Windows()) | Where-Object { $_.LocationURL -eq $url -and [Front]::IsWindowVisible([IntPtr]$_.HWND) } | Select-Object -Last 1 }',
  '$window = & $find',
  'if (-not $window) {',
  '  & cmd.exe /d /c start explorer.exe "$folder"',
  '  for ($i = 0; $i -lt 50 -and -not $window; $i++) { Start-Sleep -Milliseconds 100; $window = & $find }',
  '}',
  'if (-not $window) { throw "Explorer did not open $folder." }',
  '[Front]::Raise([IntPtr]$window.HWND)',
].join('\n')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A script as PowerShell's `-EncodedCommand` takes it: its UTF-16LE bytes in base64. */
export function encodedCommand(script: string): string {
  const bytes: number[] = []
  for (let index = 0; index < script.length; index += 1) {
    const unit = script.charCodeAt(index)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [bytes[index]!, bytes[index + 1], bytes[index + 2]]
    const word = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64[(word >> 18) & 63]! + BASE64[(word >> 12) & 63]!
    out += b === undefined ? '=' : BASE64[(word >> 6) & 63]!
    out += c === undefined ? '=' : BASE64[word & 63]!
  }

  return out
}
