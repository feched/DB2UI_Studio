; Установщик DB2UI Studio (Inno Setup 6.3+).
; Сборка:  iscc installer\db2ui.iss
; Версию можно передать так:  iscc /DMyAppVersion=1.2.3 installer\db2ui.iss

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#define MyAppName "DB2UI Studio"
#define MyAppPublisher "DB2UI"
#define MyAppExeName "DB2UI Studio.exe"
#define MyAppId "{{8B7E5A34-4C2D-4F1A-9B6E-1D2E3F4A5B6C}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist\installer
OutputBaseFilename=DB2UI-Studio-Setup-{#MyAppVersion}
SetupIconFile=..\assets\db2ui.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
VersionInfoVersion=1.0.0.0
VersionInfoCompany=DB2UI
VersionInfoDescription=Установщик DB2UI Studio
VersionInfoProductName=DB2UI Studio
VersionInfoProductVersion=1.0.0.0

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; DestName: "README.md"; Flags: ignoreversion
Source: "..\assets\db2ui.ico"; DestDir: "{app}"; DestName: "db2ui.ico"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2Client, 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2Client, 'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2Client, 'pv', Version);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not WebView2Installed then
    MsgBox(
      'На этом компьютере не найден компонент Microsoft Edge WebView2.' + #13#10 +
      'DB2UI Studio запустится в обычном браузере, но для полноценного' + #13#10 +
      'десктопного окна установите WebView2 Runtime с сайта:' + #13#10#13#10 +
      'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
      mbInformation,
      MB_OK
    );
end;
