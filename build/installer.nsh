!include "LogicLib.nsh"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
  Var JiniLocalAIWasInstalled

  Section /o "Optional: Local AI pack (embeddings + offline speech)" SEC_JINI_LOCAL_AI
    SetOutPath "$INSTDIR\resources\local-ai"
    File /r "${PROJECT_DIR}\build\local-ai\*"
  SectionEnd
  !insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
    !insertmacro MUI_DESCRIPTION_TEXT ${SEC_JINI_LOCAL_AI} "Adds local neural memory embeddings and the offline Whisper speech fallback. Not needed for API-based JINI use. Models are downloaded only when a local feature is first used."
  !insertmacro MUI_FUNCTION_DESCRIPTION_END
  !endif
!macroend

!macro customInit
  ReadRegStr $JiniLocalAIWasInstalled HKCU "Software\JINI" "LocalAIInstalled"
  StrCmp $JiniLocalAIWasInstalled "1" 0 +2
    SectionSetFlags ${SEC_JINI_LOCAL_AI} ${SF_SELECTED}
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  !define MUI_COMPONENTSPAGE_NODESC
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

!macro customInstall
  IfFileExists "$INSTDIR\resources\local-ai\node_modules\@huggingface\transformers\package.json" localAIInstalled localAINotInstalled
  localAIInstalled:
    WriteRegStr HKCU "Software\JINI" "LocalAIInstalled" "1"
    Goto localAIStateDone
  localAINotInstalled:
    DeleteRegValue HKCU "Software\JINI" "LocalAIInstalled"
  localAIStateDone:
!macroend

!macro customRemoveFiles
  RMDir /r "$INSTDIR\resources\local-ai"
!macroend

!macro customUnInstall
  RMDir /r "$INSTDIR\resources\local-ai"
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\JINI" "LocalAIInstalled"
  ${endIf}
!macroend
