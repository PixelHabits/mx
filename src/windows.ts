import { dlopen, FFIType } from "bun:ffi";
import { Effect } from "effect";
import { ChildProcess } from "effect/process";

/**
 * Whether this process is the only one attached to its console, as when Explorer starts mx.exe on a double-click in a
 * console of its own, which Windows closes as soon as mx exits. In cmd, PowerShell or Windows Terminal, the shell is
 * attached too.
 */
export const ownsConsole = Effect.sync(() => {
	const { close, symbols } = dlopen("kernel32.dll", {
		GetConsoleProcessList: {
			args: [FFIType.ptr, FFIType.u32],
			returns: FFIType.u32,
		},
	});
	// With more processes attached than the list holds, Windows fills in none of them and answers how many there are.
	const attached = symbols.GetConsoleProcessList(new Uint32Array(1), 1);
	close();
	return attached === 1;
});

/**
 * `script` in Windows PowerShell 5.1, which every Windows 10 and 11 has, with `env` added to its environment. The
 * script travels base64-encoded, so no quoting reaches it, and its inputs travel in `env`. `$ErrorActionPreference`
 * makes any failure end it with exit code 1.
 */
const powershell = (
	script: string,
	options: {
		readonly detached?: boolean;
		readonly env?: Record<string, string>;
		readonly stdout?: "pipe" | "ignore";
	} = {}
) =>
	ChildProcess.make(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(
				`$ErrorActionPreference = 'Stop'\n${script}`,
				"utf16le"
			).toString("base64"),
		],
		{
			detached: options.detached ?? false,
			env: options.env ?? {},
			extendEnv: true,
			stderr: options.detached === true ? "ignore" : "inherit",
			stdin: "ignore",
			stdout: options.stdout ?? "ignore",
		}
	);

/**
 * Prints the user's own PATH, the `Path` value under `HKCU\Environment`, as stored, with `%USERPROFILE%` and other
 * variables unexpanded, as base64 of its UTF-16 text, so no console code page changes a character of it.
 */
export const readUserPath = powershell(
	`$path = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($path))`,
	{ stdout: "pipe" }
);

/** The user's PATH that `readUserPath` printed. */
export const userPathFrom = (output: string) =>
	Buffer.from(output.trim(), "base64").toString("utf16le");

/**
 * Sets the user's own PATH to `path`, as REG_EXPAND_SZ so its variables expand, and broadcasts WM_SETTINGCHANGE, so a
 * terminal opened next sees it. The broadcast skips a window that hangs, and waits at most 5 seconds for each.
 */
export const writeUserPath = (path: string) =>
	powershell(
		`[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment').SetValue('Path', [string]$env:MX_PATH, 'ExpandString')
Add-Type -Namespace Mx -Name User32 -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$result = [UIntPtr]::Zero
[void][Mx.User32]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`,
		{ env: { MX_PATH: path } }
	);

/**
 * Stops every `mxw.exe` in this sign-in session but the process `pid`, with the processes each started, as cloudflared,
 * and waits up to 10 seconds for all of them to exit, so the files they held are free. Nothing reaches a process with
 * no window and no console to ask it to stop, so this ends them as `taskkill /F` does.
 */
export const stopSync = (pid: number) =>
	powershell(
		`$session = (Get-Process -Id $PID).SessionId
$sync = @(Get-CimInstance Win32_Process -Filter "Name = 'mxw.exe' AND SessionId = $session" | Where-Object { $_.ProcessId -ne [int]$env:MX_PID })
$started = @(Get-CimInstance Win32_Process | Where-Object { $sync.ProcessId -contains $_.ParentProcessId })
foreach ($process in $sync) { taskkill.exe /F /T /PID $process.ProcessId | Out-Null }
foreach ($process in $sync + $started) { Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction Ignore }`,
		{ env: { MX_PID: String(pid) } }
	);

/**
 * Waits for the process `pid` to exit, then deletes `folder` with everything in it. A file stays in use for a moment
 * after the process that ran it exits, so it tries for 10 seconds. It runs detached, so it outlives the process that
 * starts it.
 */
export const deleteAfterExit = ({
	folder,
	pid,
}: {
	readonly folder: string;
	readonly pid: number;
}) =>
	powershell(
		`Wait-Process -Id ([int]$env:MX_PID) -ErrorAction Ignore
for ($try = 0; $try -lt 20 -and (Test-Path -LiteralPath $env:MX_FOLDER); $try++) {
	Remove-Item -LiteralPath $env:MX_FOLDER -Recurse -Force -ErrorAction Ignore
	if (Test-Path -LiteralPath $env:MX_FOLDER) { Start-Sleep -Milliseconds 500 }
}`,
		{ detached: true, env: { MX_FOLDER: folder, MX_PID: String(pid) } }
	);
