// Ajudante de controle remoto do TelaLink (só Windows).
//
// O servidor compila este arquivo na primeira vez e conversa com ele pela
// entrada padrão, uma ordem por linha:
//
//   m <dx> <dy> <dados> <flags>   -> evento de mouse
//   k <vk> <scan> <flags>         -> evento de teclado
//
// Os números são os mesmos campos da função SendInput do Windows; quem decide
// o que mandar é o input.js. Escrito em C# 5 de propósito: é o que o
// compilador que já vem no Windows (csc.exe do .NET Framework 4) entende.

using System;
using System.Runtime.InteropServices;

public static class TelaLinkInput
{
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type; // 0 = mouse, 1 = teclado
        public InputUnion u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static int Main()
    {
        int size = Marshal.SizeOf(typeof(INPUT));
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string[] p = line.Split(' ');
            INPUT[] input = new INPUT[1];
            try
            {
                if (p[0] == "m" && p.Length == 5)
                {
                    input[0].type = 0;
                    input[0].u.mi.dx = int.Parse(p[1]);
                    input[0].u.mi.dy = int.Parse(p[2]);
                    input[0].u.mi.mouseData = unchecked((uint)int.Parse(p[3]));
                    input[0].u.mi.dwFlags = uint.Parse(p[4]);
                }
                else if (p[0] == "k" && p.Length == 4)
                {
                    input[0].type = 1;
                    input[0].u.ki.wVk = ushort.Parse(p[1]);
                    input[0].u.ki.wScan = ushort.Parse(p[2]);
                    input[0].u.ki.dwFlags = uint.Parse(p[3]);
                }
                else
                {
                    continue;
                }
            }
            catch (FormatException) { continue; }
            catch (OverflowException) { continue; }

            SendInput(1, input, size);
        }
        return 0;
    }
}
