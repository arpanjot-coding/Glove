; SPDX-License-Identifier: MIT
Unicode True
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "x64.nsh"

Name "Glove"
OutFile "${GLOVE_SETUP}"
InstallDir "$LOCALAPPDATA\Programs\Glove"
VIProductVersion "${GLOVE_VERSION}.0"
VIAddVersionKey "ProductName" "Glove"
VIAddVersionKey "CompanyName" "Glove contributors"
VIAddVersionKey "LegalCopyright" "Copyright 2026 Glove contributors"
VIAddVersionKey "FileDescription" "Glove Setup for Windows"
VIAddVersionKey "FileVersion" "${GLOVE_VERSION}"
VIAddVersionKey "ProductVersion" "${GLOVE_VERSION}"

!define MUI_ICON "..\assets\glove.ico"
!define MUI_UNICON "..\assets\glove.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Glove.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Glove"
!define GLOVE_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Glove"
!define GLOVE_SETUP_MUTEX "Local\Glove.Setup"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${GLOVE_SETUP_MUTEX}") p .r1 ?e'
  Pop $2
  ${If} $1 == 0
  ${OrIf} $2 == 183
    MessageBox MB_ICONSTOP "Another Glove Setup is already running." /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Glove requires 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  FindWindow $0 "" "Glove"
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Close Glove, then run Setup again." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "Glove"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r /x "debug.log" "${GLOVE_PACKAGE}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Glove.lnk" "$INSTDIR\Glove.exe"
  WriteRegStr HKCU "${GLOVE_UNINSTALL_KEY}" "DisplayName" "Glove"
  WriteRegStr HKCU "${GLOVE_UNINSTALL_KEY}" "DisplayVersion" "${GLOVE_VERSION}"
  WriteRegStr HKCU "${GLOVE_UNINSTALL_KEY}" "Publisher" "Glove contributors"
  WriteRegStr HKCU "${GLOVE_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Glove.exe"
  WriteRegStr HKCU "${GLOVE_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${GLOVE_UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${GLOVE_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${GLOVE_UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${GLOVE_SETUP_MUTEX}") p .r1 ?e'
  Pop $2
  ${If} $1 == 0
  ${OrIf} $2 == 183
    MessageBox MB_ICONSTOP "Another Glove Setup is already running." /SD IDOK
    Abort
  ${EndIf}
  FindWindow $0 "" "Glove"
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Close Glove before uninstalling." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\Glove.lnk"
  DeleteRegKey HKCU "${GLOVE_UNINSTALL_KEY}"
  !include "${GLOVE_UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
