{
  "targets": [
    {
      "target_name": "runshi_selection",
      "sources": ["native/macos-selection.mm"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"],
            "OTHER_LDFLAGS": [
              "-framework", "AppKit",
              "-framework", "ApplicationServices"
            ]
          }
        }]
      ]
    }
  ]
}
