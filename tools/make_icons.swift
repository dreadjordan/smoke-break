// Draws Smoke Break's icons from one cigarette-and-smoke glyph: the macOS menu bar template, and the app icon on a DreadJordan-blue tile.
// Run from the project root: swift tools/make_icons.swift, which writes assets/ and build/ (build/icon.icns needs iconutil).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Sampled from the blues of DreadJordan's profile picture.
let tileTop = CGColor(red: 0.16, green: 0.26, blue: 0.68, alpha: 1)
let tileBottom = CGColor(red: 0.04, green: 0.06, blue: 0.22, alpha: 1)

// The glyph on an 18-unit grid, in the given colour.
func drawGlyph(in context: CGContext, colour: CGColor) {
  context.setFillColor(colour)
  context.setStrokeColor(colour)
  context.fill(CGRect(x: 1.5, y: 3.5, width: 4.5, height: 3.5))
  context.fill(CGRect(x: 7, y: 3.5, width: 9.5, height: 3.5))
  context.setLineWidth(1.5)
  context.setLineCap(.round)
  context.move(to: CGPoint(x: 14.5, y: 9.5))
  context.addCurve(to: CGPoint(x: 14.5, y: 16), control1: CGPoint(x: 11.5, y: 11.5), control2: CGPoint(x: 17.5, y: 13.5))
  context.strokePath()
}

func newContext(_ size: Int) -> CGContext {
  CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func pngData(_ context: CGContext) -> Data {
  let data = NSMutableData()
  let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  CGImageDestinationFinalize(destination)
  return data as Data
}

func template(_ size: Int) -> Data {
  let context = newContext(size)
  context.scaleBy(x: CGFloat(size) / 18, y: CGFloat(size) / 18)
  drawGlyph(in: context, colour: CGColor(gray: 0, alpha: 1))
  return pngData(context)
}

// `inset` is the empty margin around the tile, as a fraction of the icon: macOS icons sit inside one, Windows icons fill theirs.
func tile(_ size: Int, inset: CGFloat, cornerFraction: CGFloat) -> Data {
  let context = newContext(size)
  let side = CGFloat(size) * (1 - inset * 2)
  let origin = CGFloat(size) * inset
  let shape = CGPath(roundedRect: CGRect(x: origin, y: origin, width: side, height: side), cornerWidth: side * cornerFraction, cornerHeight: side * cornerFraction, transform: nil)
  if inset > 0 {
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -CGFloat(size) * 0.012), blur: CGFloat(size) * 0.03, color: CGColor(gray: 0, alpha: 0.35))
    context.addPath(shape)
    context.setFillColor(tileBottom)
    context.fillPath()
    context.restoreGState()
  }
  context.saveGState()
  context.addPath(shape)
  context.clip()
  let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [tileTop, tileBottom] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: origin + side), end: CGPoint(x: 0, y: origin), options: [])
  context.restoreGState()
  // The glyph takes about two thirds of the tile, centred on its own bounds.
  let scale = side * 0.68 / 15
  context.translateBy(x: origin + side / 2 - 9 * scale, y: origin + side / 2 - 9.75 * scale)
  context.scaleBy(x: scale, y: scale)
  drawGlyph(in: context, colour: CGColor(gray: 1, alpha: 1))
  return pngData(context)
}

func windowsIcon(sizes: [Int]) -> Data {
  var header = Data([0, 0, 1, 0, UInt8(sizes.count), 0])
  var images = Data()
  var offset = 6 + 16 * sizes.count
  for size in sizes {
    let png = tile(size, inset: 0, cornerFraction: 0.18)
    let byte = UInt8(size == 256 ? 0 : size)
    header.append(contentsOf: [byte, byte, 0, 0, 1, 0, 32, 0])
    withUnsafeBytes(of: UInt32(png.count).littleEndian) { header.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt32(offset).littleEndian) { header.append(contentsOf: $0) }
    images.append(png)
    offset += png.count
  }
  return header + images
}

func write(_ data: Data, _ path: String) {
  try! data.write(to: URL(fileURLWithPath: path))
}

let macInset: CGFloat = 0.098
let macCorner: CGFloat = 0.225
write(template(18), "assets/trayTemplate.png")
write(template(36), "assets/trayTemplate@2x.png")
write(tile(512, inset: macInset, cornerFraction: macCorner), "assets/app-icon.png")
write(tile(16, inset: 0, cornerFraction: 0.18), "assets/tray.png")
write(tile(32, inset: 0, cornerFraction: 0.18), "assets/tray@2x.png")
write(windowsIcon(sizes: [16, 24, 32, 48, 64, 128, 256]), "build/icon.ico")

let iconset = NSTemporaryDirectory() + "smoke-break-icon.iconset"
try! FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
  write(tile(points, inset: macInset, cornerFraction: macCorner), "\(iconset)/icon_\(points)x\(points).png")
  write(tile(points * 2, inset: macInset, cornerFraction: macCorner), "\(iconset)/icon_\(points)x\(points)@2x.png")
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset, "-o", "build/icon.icns"]
try! iconutil.run()
iconutil.waitUntilExit()
