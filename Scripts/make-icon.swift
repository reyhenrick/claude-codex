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
        NSGradient(starting: NSColor(calibratedRed: 0.12, green: 0.34, blue: 0.72, alpha: 1), ending: NSColor(calibratedRed: 0.08, green: 0.63, blue: 0.72, alpha: 1))!.draw(in: path, angle: 45)
        NSColor.white.withAlphaComponent(0.94).setStroke()
        for x in [p*0.25, p*0.47] {
            let circle = NSBezierPath(ovalIn: NSRect(x: x, y: p*0.35, width: p*0.28, height: p*0.28)); circle.lineWidth = max(1, p*0.045); circle.stroke()
        }
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output+"/icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
    }
}
