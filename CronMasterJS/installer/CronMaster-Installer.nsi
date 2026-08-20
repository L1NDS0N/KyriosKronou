; CronMaster NSIS Installer Script
; Generated for CronMaster v1.0.0
; Author: l1nds0n

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"

; ─── General ────────────────────────────────────────────
Name "CronMaster"
OutFile "..\dist\CronMaster-Setup-1.0.0.exe"
InstallDir "$LOCALAPPDATA\CronMaster"
InstallDirRegKey HKCU "Software\CronMaster" "InstallDir"
RequestExecutionLevel admin
Unicode True
SetCompressor /SOLID lzma
BrandingText "CronMaster v1.0.0"

; ─── Version Info ───────────────────────────────────────
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "CronMaster"
VIAddVersionKey "CompanyName" "l1nds0n"
VIAddVersionKey "FileDescription" "CronMaster Installer"
VIAddVersionKey "FileVersion" "1.0.0"
VIAddVersionKey "ProductVersion" "1.0.0"
VIAddVersionKey "LegalCopyright" "Copyright 2026 l1nds0n"
VIAddVersionKey "OriginalFilename" "CronMaster-Setup-1.0.0.exe"

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
Section "CronMaster (required)" SecMain
  SectionIn RO

  ; Set output path to installation directory
  SetOutPath "$INSTDIR"

  ; Install all files from the unpacked build
  File /r "..\build\CronMaster-win32-x64\*.*"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Create Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\CronMaster"
  CreateShortCut "$SMPROGRAMS\CronMaster\CronMaster.lnk" "$INSTDIR\CronMaster.exe" "" "$INSTDIR\CronMaster.exe" 0
  CreateShortCut "$SMPROGRAMS\CronMaster\Uninstall CronMaster.lnk" "$INSTDIR\uninstall.exe"

  ; Create Desktop shortcut
  CreateShortCut "$DESKTOP\CronMaster.lnk" "$INSTDIR\CronMaster.exe" "" "$INSTDIR\CronMaster.exe" 0

  ; Save installation path to registry
  WriteRegStr HKCU "Software\CronMaster" "InstallDir" "$INSTDIR"

  ; Write uninstall registry keys
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "DisplayName" "CronMaster"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "DisplayIcon" "$\"$INSTDIR\CronMaster.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "Publisher" "l1nds0n"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "DisplayVersion" "1.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "URLInfoAbout" "https://github.com/l1nds0n/CronMaster"

  ; Calculate and write estimated size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster" "EstimatedSize" "$0"

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

  ; Remove files
  RMDir /r "$INSTDIR"

  ; Remove Start Menu shortcuts
  RMDir /r "$SMPROGRAMS\CronMaster"

  ; Remove Desktop shortcut
  Delete "$DESKTOP\CronMaster.lnk"

  ; Remove registry keys
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CronMaster"
  DeleteRegKey HKCU "Software\CronMaster"

  ; Remove from PATH
  ReadRegStr $0 HKCU "Environment" "Path"
  ${WordReplace} $0 "$INSTDIR;" "" +1 $1
  ${WordReplace} $1 ";$INSTDIR" "" +1 $2
  WriteRegStr HKCU "Environment" "Path" $2

SectionEnd
