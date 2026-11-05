# Microsoft Visual C++ runtime

Copyright Microsoft Corporation. All rights reserved.

The app-local Microsoft Visual C++ v14 x64 runtime DLLs are unmodified files extracted from Microsoft's official Visual C++ Redistributable 14.51.36247 package. They support the bundled whisper.cpp speech executable. They are not covered by this project's MIT license.

- [Microsoft runtime license terms](https://aka.ms/VCRedistLicense)
- [Microsoft's redistribution information](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)
- [Microsoft's app-local deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp)
- [Official package downloads](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)

Runtime files are copied into the speech executable's application folder. The setup script does not install the redistributable globally, request administrator access, alter Windows files, or register a package. Redistributing these components remains subject to Microsoft's applicable license terms. Update the pinned package and rebuild the installer when servicing these app-local libraries.
