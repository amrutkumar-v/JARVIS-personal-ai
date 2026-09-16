// JARVIS Native Windows Agent — shell-activation helper (Windows only).
//
// Windows packaged (Store/MSIX / UWP) applications require FOREGROUND
// activation through the shell. Activated by plain CreateProcess — which is
// what Node's child_process.spawn/execFile always uses — a packaged app is
// treated as a background activation that is quietly torn down seconds later:
// a process may be observed running, but no real window ever remains. That is
// why JARVIS must activate packaged apps through ShellExecuteEx (the same call
// the Start menu and "Start-Process" use), never through CreateProcess.
//
// This helper is a single-purpose, fail-closed gateway: it accepts ONLY one
// already-validated shell route (a shell:AppsFolder AUMID or an allow-listed
// URI such as ms-settings:), performs ShellExecute with the "open" verb, and
// returns when activation has been handed to the shell. It never builds a
// command line or a command string; it carries no user or model text. The
// agent remains the single source of truth for what may be launched; this
// binary only repeats the same structural validation as defense in depth.
//
// Build:  csc /nologo /target:winexe /out:ShellExec.exe ShellExec.cs
// Run:    ShellExec.exe <shell-route>
// Bits:   AnyCPU (runs fine on x64 Windows).

using System;
using System.Runtime.InteropServices;

internal static class ShellExec
{
    private const uint SW_SHOWNORMAL = 1;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr ShellExecute(IntPtr hwnd, string lpOperation, string lpFile, string lpParameters, string lpDirectory, int nShowCmd);

    /// <summary>AUMID charset — conservative, never a path.</summary>
    private static bool IsValidAumidRoute(string value)
    {
        // shell:AppsFolder\<AUMID> where AUMID = package!App (plus optional qualifiers).
        if (!value.StartsWith("shell:AppsFolder\\", StringComparison.OrdinalIgnoreCase))
            return false;
        string aumid = value.Substring("shell:AppsFolder\\".Length);
        if (aumid.Length < 8 || aumid.Length > 260)
            return false;
        if (!aumid.Contains("!"))
            return false;
        foreach (char c in aumid)
        {
            if (!char.IsLetterOrDigit(c) && c != '_' && c != '!' && c != '.' && c != '+' && c != '-' && c != ':')
                return false;
        }
        return true;
    }

    /// <summary>Allow-listed scheme routes (mirror of the agent's ALLOWED_URI_SCHEMES).</summary>
    private static bool IsAllowedUri(string value)
    {
        if (value.StartsWith("ms-settings:", StringComparison.OrdinalIgnoreCase))
        {
            if (value.Length > 260)
                return false;
            foreach (char c in value)
            {
                if (char.IsControl(c) || c == '"' || c == '\'' || c == '`')
                    return false;
            }
            return true;
        }
        return false;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args == null || args.Length != 1)
            return 5; // usage: exactly one shell route
        string route = args[0];
        if (!IsValidAumidRoute(route) && !IsAllowedUri(route))
            return 4; // fail closed: nothing but a validated shell route is ever executed

        IntPtr result = ShellExecute(IntPtr.Zero, "open", route, null, null, (int)SW_SHOWNORMAL);
        if (result.ToInt64() <= 32)
            return 3; // ShellExecute failed (return value is an error code)

        return 0;
    }
}