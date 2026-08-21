; Kyrion Kronou NSIS Installer Script
; Generated for Kyrion Kronou v1.0.0
; Author: l1nds0n

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"

; ─── General ────────────────────────────────────────────
Name "Kyrion Kronou"
OutFile "..\dist\KyrionKronou-Setup-1.0.0.exe"
InstallDir "$LOCALAPPDATA\KyrionKronou"
InstallDirRegKey HKCU "Software\KyrionKronou" "InstallDir"
RequestExecutionLevel admin
Unicode True
SetCompressor /SOLID lzma
BrandingText "Kyrion Kronou v1.0.0"

; ─── Version Info ───────────────────────────────────────
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "Kyrion Kronou"
VIAddVersionKey "CompanyName" "l1nds0n"
VIAddVersionKey "FileDescription" "Kyrion Kronou Installer"
VIAddVersionKey "FileVersion" "1.0.0"
VIAddVersionKey "ProductVersion" "1.0.0"
VIAddVersionKey "LegalCopyright" "Copyright 2026 l1nds0n"
VIAddVersionKey "OriginalFilename" "KyrionKronou-Setup-1.0.0.exe"

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
Section "Kyrion Kronou (required)" SecMain
  SectionIn RO

  ; Set output path to installation directory
  SetOutPath "$INSTDIR"

  ; Install all files from the unpacked build
  File /r "..\build\KyrionKronou-win32-x64\*.*"

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Create Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\Kyrion Kronou"
  CreateShortCut "$SMPROGRAMS\Kyrion Kronou\Kyrion Kronou.lnk" "$INSTDIR\KyrionKronou.exe" "" "$INSTDIR\KyrionKronou.exe" 0
  CreateShortCut "$SMPROGRAMS\Kyrion Kronou\Uninstall Kyrion Kronou.lnk" "$INSTDIR\uninstall.exe"

  ; Create Desktop shortcut
  CreateShortCut "$DESKTOP\Kyrion Kronou.lnk" "$INSTDIR\KyrionKronou.exe" "" "$INSTDIR\KyrionKronou.exe" 0

  ; Save installation path to registry
  WriteRegStr HKCU "Software\KyrionKronou" "InstallDir" "$INSTDIR"

  ; Write uninstall registry keys
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "DisplayName" "Kyrion Kronou"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "DisplayIcon" "$\"$INSTDIR\KyrionKronou.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "Publisher" "l1nds0n"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "DisplayVersion" "1.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "URLInfoAbout" "https://github.com/l1nds0n/kyrion-kronou"

  ; Calculate and write estimated size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou" "EstimatedSize" "$0"

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
  RMDir /r "$SMPROGRAMS\Kyrion Kronou"

  ; Remove Desktop shortcut
  Delete "$DESKTOP\Kyrion Kronou.lnk"

  ; Remove registry keys
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KyrionKronou"
  DeleteRegKey HKCU "Software\KyrionKronou"

  ; Remove from PATH
  ReadRegStr $0 HKCU "Environment" "Path"
  ${WordReplace} $0 "$INSTDIR;" "" +1 $1
  ${WordReplace} $1 ";$INSTDIR" "" +1 $2
  WriteRegStr HKCU "Environment" "Path" $2

SectionEnd
