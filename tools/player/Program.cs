// Запускатор готового приложения DB2UI для экспорта в один .exe.
//
// Формат файла:
//   [этот запускатор][ZIP рантайма][ZIP данных проекта][40 байт трейлера]
// Трейлер: <int64 off1><int64 len1><int64 off2><int64 len2><8 байт "DB2UIEXE">.
//
// Рантайм распаковывается в %LOCALAPPDATA%\DB2UI Player\<hash> один раз,
// данные проекта перезаписываются при каждом запуске. Затем запускается
// встроенный python.exe с app.py.
//
// Сборка: tools/build_player.py (csc из .NET Framework 4.x).

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

static class Program
{
    private const string Magic = "DB2UIEXE";
    private const int TrailerSize = 40;

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            string exePath = Process.GetCurrentProcess().MainModule.FileName;
            byte[] runtime;
            byte[] data;

            using (FileStream fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (fs.Length < TrailerSize + 4)
                {
                    return 1;
                }
                fs.Seek(-TrailerSize, SeekOrigin.End);
                byte[] trailer = new byte[TrailerSize];
                ReadExactly(fs, trailer, 0, TrailerSize);
                string magic = Encoding.ASCII.GetString(trailer, 32, 8);
                if (magic != Magic)
                {
                    return 2;
                }
                long offset1 = BitConverter.ToInt64(trailer, 0);
                long length1 = BitConverter.ToInt64(trailer, 8);
                long offset2 = BitConverter.ToInt64(trailer, 16);
                long length2 = BitConverter.ToInt64(trailer, 24);
                if (offset1 <= 0 || length1 <= 0 || offset2 <= 0 || length2 <= 0)
                {
                    return 3;
                }
                if (offset1 + length1 > fs.Length || offset2 + length2 > fs.Length)
                {
                    return 3;
                }
                runtime = ReadBlock(fs, offset1, length1);
                data = ReadBlock(fs, offset2, length2);
            }

            string hash = Sha256Hex(runtime);
            string baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DB2UI Player",
                hash.Substring(0, 16)
            );
            string marker = Path.Combine(baseDir, ".ready");
            if (!File.Exists(marker))
            {
                Directory.CreateDirectory(baseDir);
                ExtractZip(runtime, baseDir);
                File.WriteAllText(marker, hash);
            }
            // Данные проекта небольшие: обновляем их при каждом запуске,
            // чтобы пересобранный .exe сразу открывал новый интерфейс.
            ExtractZip(data, baseDir);

            string python = Path.Combine(baseDir, "python.exe");
            if (!File.Exists(python))
            {
                python = Path.Combine(baseDir, "pythonw.exe");
            }
            if (!File.Exists(python))
            {
                MessageBox.Show(
                    "Не удалось найти встроенный Python в приложении.",
                    "DB2UI App",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return 4;
            }

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = python;
            info.Arguments = "\"" + Path.Combine(baseDir, "app.py") + "\"";
            info.WorkingDirectory = baseDir;
            info.UseShellExecute = true;
            Process.Start(info);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Не удалось запустить приложение.\r\n\r\n" + ex.Message,
                "DB2UI App",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 5;
        }
    }

    private static byte[] ReadBlock(FileStream fs, long offset, long length)
    {
        fs.Seek(offset, SeekOrigin.Begin);
        byte[] buffer = new byte[length];
        ReadExactly(fs, buffer, 0, (int)length);
        return buffer;
    }

    private static void ExtractZip(byte[] payload, string baseDir)
    {
        using (MemoryStream ms = new MemoryStream(payload))
        using (ZipArchive archive = new ZipArchive(ms, ZipArchiveMode.Read))
        {
            string root = Path.GetFullPath(baseDir) + Path.DirectorySeparatorChar;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string target = Path.GetFullPath(Path.Combine(baseDir, entry.FullName));
                if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (String.IsNullOrEmpty(entry.Name))
                {
                    Directory.CreateDirectory(target);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                entry.ExtractToFile(target, true);
            }
        }
    }

    private static string Sha256Hex(byte[] payload)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] digest = sha.ComputeHash(payload);
            StringBuilder sb = new StringBuilder(digest.Length * 2);
            foreach (byte b in digest)
            {
                sb.Append(b.ToString("x2"));
            }
            return sb.ToString();
        }
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        int read = 0;
        while (read < count)
        {
            int chunk = stream.Read(buffer, offset + read, count - read);
            if (chunk <= 0)
            {
                throw new EndOfStreamException();
            }
            read += chunk;
        }
    }
}
