; Kyrios Chronos NSIS Installer Script
; Generated for Kyrios Chronos v1.0.0
; Author: l1nds0n

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"

; ─── General ────────────────────────────────────────────
Name "Kyrios Chronos"
OutFile "..\dist\KyriosChronos-Setup-1.0.0.exe"
InstallDir "$LOCALAPPDATA\KyriosChronos"
InstallDirRegKey HKCU "Software\KyriosChronos" "InstallDir"
RequestExecutionLevel admin
Unicode True
SetCompressor /SOLID lzma
BrandingText "Kyrios Chronos v1.0.0"

; ─── Version Info ───────────────────────────────────────
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "Kyrios Chronos"
VIAddVersionKey "CompanyName" "l1nds0n"
VIAddVersionKey "FileDescription" "Kyrios Chronos Installer"
VIAddVersionKey "FileVersion" "1.0.0"
VIAddVersionKey "ProductVersion" "1.0.0"
VIAddVersionKey "LegalCopyright" "Copyright 2026 l1nds0n"
VIAddVersionKey "OriginalFilename" "KyriosChronos-Setup-1.0.0.exe"

; ─── MUI Settings ──────────────────────────────────────
!define MUI_ABORTWARNING
!define MUI_ICON "..\build-resources\icon.ico"
!define MUI_UNICON "..\build-resources\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "..\build-resources\sidebar.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "..\build-resources\sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "..\build-resources\sidebar.bmp"

; ─── Pages ──────────────────────────────────────────────
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; ─── Languages ──────────────────────────────────────────
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "PortugueseBR"

; Uninstall prompts
LangString KeepDataMsg ${LANG_ENGLISH} "Keep your tasks, backup profiles, schedules and logs?$\r$\n$\r$\nYes - keep them, so reinstalling restores everything.$\r$\nNo - delete all data permanently."
LangString KeepDataMsg ${LANG_PORTUGUESEBR} "Manter suas tarefas, perfis de backup, agendamentos e logs?$\r$\n$\r$\nSim - manter, para que a reinstalacao restaure tudo.$\r$\nNao - apagar todos os dados permanentemente."

; ─── Installer Init ─────────────────────────────────────
Function .onInit
  ; Set language based on system
  System::Call 'kernel32::GetUserDefaultUILanguage(i *) i .r0'
  ${If} $0 == 1046  ; Portuguese (Brazil)
    StrCpy $LANGUAGE 1046
  ${Else}
    StrCpy $LANGUAGE 1033  ; English
  ${EndIf}
FunctionEnd

; ─── Installer Sections ─────────────────────────────────
Section "Kyrios Chronos (required)" SecMain
  SectionIn RO

  ; Set output path to installation directory
  SetOutPath "$INSTDIR"

  ; Install all files from the unpacked build
  File /r "..\build\KyriosChronos-win32-x64\*.*"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Create Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\Kyrios Chronos"
  CreateShortCut "$SMPROGRAMS\Kyrios Chronos\Kyrios Chronos.lnk" "$INSTDIR\KyriosChronos.exe" "" "$INSTDIR\KyriosChronos.exe" 0
  CreateShortCut "$SMPROGRAMS\Kyrios Chronos\Uninstall Kyrios Chronos.lnk" "$INSTDIR\uninstall.exe"

  ; Create Desktop shortcut
  CreateShortCut "$DESKTOP\Kyrios Chronos.lnk" "$INSTDIR\KyriosChronos.exe" "" "$INSTDIR\KyriosChronos.exe" 0

  ; Save installation path to registry
  WriteRegStr HKCU "Software\KyriosChronos" "InstallDir" "$INSTDIR"

  ; Write uninstall registry keys
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "DisplayName" "Kyrios Chronos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "DisplayIcon" "$\"$INSTDIR\KyriosChronos.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "Publisher" "l1nds0n"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "DisplayVersion" "1.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "URLInfoAbout" "https://github.com/l1nds0n/kyrion-kronou"

  ; Calculate and write estimated size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos" "EstimatedSize" "$0"

  ; Add to PATH via registry (user-level)
  ReadRegStr $0 HKCU "Environment" "Path"
  ; Check if already in PATH
  StrLen $2 "$INSTDIR"
  StrCpy $3 $0 $2
  ${If} $3 != "$INSTDIR"
    StrCpy $0 "$INSTDIR;$0"
    WriteRegStr HKCU "Environment" "Path" $0
  ${EndIf}

SectionEnd

; ─── Uninstaller Section ────────────────────────────────
Section "Uninstall"

  ; Stop and remove the Windows service first. Without this the uninstaller
  ; leaves an orphaned service pointing at an executable it just deleted.
  DetailPrint "Stopping the Kyrios Chronos service..."
  nsExec::ExecToLog 'net stop "KyriosChronos"'
  Pop $0
  nsExec::ExecToLog 'sc delete "KyriosChronos"'
  Pop $0

  ; Close a running instance so $INSTDIR is not locked.
  nsExec::ExecToLog 'taskkill /F /IM KyriosChronos.exe'
  Pop $0
  Sleep 1000

  ; Ask before destroying the user's configuration. Reinstalling is routine
  ; during upgrades and nobody wants to rebuild every task by hand.
  MessageBox MB_YESNO|MB_ICONQUESTION "$(KeepDataMsg)" /SD IDYES IDYES KeepData IDNO DeleteData

  DeleteData:
    DetailPrint "Removing configuration and logs..."
    ; Read ProgramData from the environment rather than assuming an NSIS
    ; constant exists for it.
    ReadEnvStr $R0 "ProgramData"
    ${If} $R0 != ""
      RMDir /r "$R0\KyriosChronos"
    ${EndIf}
    ; Legacy per-user locations from earlier versions
    RMDir /r "$APPDATA\KyriosChronos"
    RMDir /r "$APPDATA\KyrionKronou"
    RMDir /r "$APPDATA\CronMaster"
    Goto DataDone

  KeepData:
    ReadEnvStr $R0 "ProgramData"
    DetailPrint "Keeping configuration in $R0\KyriosChronos"

  DataDone:

  ; Remove files
  RMDir /r "$INSTDIR"

  ; Remove Start Menu shortcuts
  RMDir /r "$SMPROGRAMS\Kyrios Chronos"

  ; Remove Desktop shortcut
  Delete "$DESKTOP\Kyrios Chronos.lnk"

  ; Remove registry keys
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyriosChronos"
  DeleteRegKey HKCU "Software\KyriosChronos"

  ; Remove from PATH
  ReadRegStr $0 HKCU "Environment" "Path"
  ${WordReplace} $0 "$INSTDIR;" "" +1 $1
  ${WordReplace} $1 ";$INSTDIR" "" +1 $2
  WriteRegStr HKCU "Environment" "Path" $2

SectionEnd
