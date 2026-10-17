import AppKit
let output = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let p = CGFloat(pixels), inset = p * 0.08
        let rect = NSRect(x: inset, y: inset, width: p - inset*2, height: p - inset*2)
        let path = NSBezierPath(roundedRect: rect, xRadius: p*0.21, yRadius: p*0.21)
        NSColor(calibratedRed: 0.10, green: 0.32, blue: 0.67, alpha: 1).setFill()
        path.fill()
        let configuration = NSImage.SymbolConfiguration(pointSize: p * 0.54, weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
        guard let symbol = NSImage(systemSymbolName: "terminal", accessibilityDescription: nil)?.withSymbolConfiguration(configuration) else {
            fatalError("The code symbol is unavailable.")
        }
        let factor = p * 0.56 / max(symbol.size.width, symbol.size.height)
        let width = symbol.size.width * factor, height = symbol.size.height * factor
        symbol.draw(in: NSRect(x: (p - width) / 2, y: (p - height) / 2, width: width, height: height))
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output+"/icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
    }
}
