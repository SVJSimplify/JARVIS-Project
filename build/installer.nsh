!include "LogicLib.nsh"

!macro customHeader
  Var JiniLocalAIWasInstalled

  Section /o "Local AI support - Hugging Face embeddings" SEC_JINI_LOCAL_AI
    SetOutPath "$INSTDIR\\resources\\local-ai"
    File /r "${PROJECT_DIR}\\build\\local-ai\\*"
    WriteRegStr HKCU "Software\\JINI" "LocalAIInstalled" "1"
  SectionEnd
!macroend

!macro customInit
  ReadRegStr $JiniLocalAIWasInstalled HKCU "Software\\JINI" "LocalAIInstalled"
  StrCmp $JiniLocalAIWasInstalled "1" 0 +2
    SectionSetFlags ${SEC_JINI_LOCAL_AI} ${SF_SELECTED}
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  !define MUI_COMPONENTSPAGE_NODESC
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

!macro customRemoveFiles
  RMDir /r "$INSTDIR\\resources\\local-ai"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\\JINI" "LocalAIInstalled"
  ${endIf}
!macroend
