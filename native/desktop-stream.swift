// Smoke Break's resident capture helper: for each break it sends a snapshot of the display, a small ScreenCaptureKit feed with Smoke Break's window left out, and runs distant-audio.swift.
// Frames go to stdout as a 16-byte header (kind, width, height, byte count) then the data; stdin takes "begin <display> <process ids> <sound|silent> <live|still>", "distance <0-1>", "still", "alive", "end", "request-access" and "request-audio-access".
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Why: the screen is about 570 pixels wide across the room on a Retina display, so this is sharp there at a small cost per frame.
let liveWidth = 640
// Why: moving pictures this small gain nothing visible above 30fps, and it halves the data crossing into the app.
let liveFramesPerSecond: Int32 = 30
// Why: a raw Retina frame is 30MB and stalled the return dash for about 100ms; a JPEG is far smaller and decodes off the render thread.
let stillQuality = 0.9
let headerBytes = 16

enum FrameKind: UInt32 {
  case live = 0
  case still = 1
  case snapshot = 2
}

final class FrameWriter: NSObject, SCStreamOutput, SCStreamDelegate {
  let queue = DispatchQueue(label: "smokebreak.frames", qos: .userInteractive)
  private var packed = [UInt8]()

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, isCompleteFrame(sampleBuffer), let pixelBuffer = sampleBuffer.imageBuffer else { return }
    writePixels(pixelBuffer, kind: .live)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail(error)
  }

  // Why: the write blocks when the app falls behind, which makes ScreenCaptureKit drop frames rather than queue up stale ones.
  func writePixels(_ pixelBuffer: CVPixelBuffer, kind: FrameKind) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let sourceRowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let packedRowBytes = width * 4
    let totalBytes = headerBytes + packedRowBytes * height
    if packed.count != totalBytes { packed = [UInt8](repeating: 0, count: totalBytes) }
    guard let source = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
    packed.withUnsafeMutableBytes { destination in
      storeHeader(in: destination, kind: kind, width: width, height: height, byteCount: packedRowBytes * height)
      for row in 0..<height {
        memcpy(destination.baseAddress! + headerBytes + row * packedRowBytes, source + row * sourceRowBytes, packedRowBytes)
      }
      writeAll(UnsafeRawBufferPointer(destination))
    }
  }

  func writeStill(_ image: CGImage) {
    let jpeg = NSMutableData()
    guard let encoder = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(encoder, image, [kCGImageDestinationLossyCompressionQuality: stillQuality] as CFDictionary)
    guard CGImageDestinationFinalize(encoder) else { return }
    var header = [UInt8](repeating: 0, count: headerBytes)
    header.withUnsafeMutableBytes { destination in
      storeHeader(in: destination, kind: .still, width: image.width, height: image.height, byteCount: jpeg.length)
      writeAll(UnsafeRawBufferPointer(destination))
    }
    writeAll(UnsafeRawBufferPointer(start: jpeg.bytes, count: jpeg.length))
  }

  private func storeHeader(in destination: UnsafeMutableRawBufferPointer, kind: FrameKind, width: Int, height: Int, byteCount: Int) {
    destination.storeBytes(of: kind.rawValue.littleEndian, toByteOffset: 0, as: UInt32.self)
    destination.storeBytes(of: UInt32(width).littleEndian, toByteOffset: 4, as: UInt32.self)
    destination.storeBytes(of: UInt32(height).littleEndian, toByteOffset: 8, as: UInt32.self)
    destination.storeBytes(of: UInt32(byteCount).littleEndian, toByteOffset: 12, as: UInt32.self)
  }

  private func writeAll(_ bytes: UnsafeRawBufferPointer) {
    var offset = 0
    while offset < bytes.count {
      let written = Darwin.write(STDOUT_FILENO, bytes.baseAddress! + offset, bytes.count - offset)
      if written < 0 {
        if errno == EINTR { continue }
        exit(0)
      }
      offset += written
    }
  }

  private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let rawStatus = attachments.first?[.status] as? Int
    else { return false }
    return SCFrameStatus(rawValue: rawStatus) == .complete
  }
}

// Kept here so they live as long as the process.
var appExitWatch: DispatchSourceProcess?
var frozenAppWatch: DispatchSourceTimer?
// Why: the break window covers even the Force Quit window, so a frozen app would leave the Mac unusable; this process is the only thing still able to act.
let frozenAppLimitNanoseconds: UInt64 = 8_000_000_000

func fail(_ error: Error) -> Never {
  FileHandle.standardError.write(Data("desktop-stream: \(error)\n".utf8))
  exit(1)
}

func configuration(width: Int, height: Int) -> SCStreamConfiguration {
  let configuration = SCStreamConfiguration()
  configuration.width = width
  configuration.height = height
  configuration.pixelFormat = kCVPixelFormatType_32BGRA
  configuration.colorSpaceName = CGColorSpace.sRGB
  configuration.showsCursor = false
  return configuration
}

struct DesktopCapture {
  let filter: SCContentFilter
  let stillConfiguration: SCStreamConfiguration
  let stream: SCStream?
}

func shareableContent() async throws -> SCShareableContent {
  try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
}

// Why: fetching without permission makes macOS show its prompt at launch, on top of the app's own explanation. A break fetches again when this fails.
func prefetchContent() -> Task<SCShareableContent, Error> {
  Task.detached {
    guard CGPreflightScreenCaptureAccess() else { throw CancellationError() }
    return try await shareableContent()
  }
}

func startCapture(content: SCShareableContent, displayId: UInt32, appProcess: Int32, live: Bool, writer: FrameWriter) async throws -> DesktopCapture {
  guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
    FileHandle.standardError.write(Data("desktop-stream: display \(displayId) not found\n".utf8))
    exit(1)
  }
  let excluded = content.applications.filter { $0.processID == appProcess }
  let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])

  // Why: this frame gates the break's start, and at point resolution it is a quarter of the Retina data. It only ever shows during
  // the first burst of the dash, shrinking fast under speed lines, where the softness cannot be seen.
  let snapshot = try await SCScreenshotManager.captureSampleBuffer(
    contentFilter: filter, configuration: configuration(width: display.width, height: display.height))
  if let pixelBuffer = snapshot.imageBuffer { writer.queue.sync { writer.writePixels(pixelBuffer, kind: .snapshot) } }

  let stillConfiguration = configuration(
    width: Int(Float(display.width) * filter.pointPixelScale),
    height: Int(Float(display.height) * filter.pointPixelScale))
  // Why: with the background filled there is no distant screen to feed, so nothing is streamed at all.
  guard live else { return DesktopCapture(filter: filter, stillConfiguration: stillConfiguration, stream: nil) }

  let liveHeight = (liveWidth * display.height / display.width + 1) & ~1
  let liveConfiguration = configuration(width: liveWidth, height: liveHeight)
  liveConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: liveFramesPerSecond)
  liveConfiguration.queueDepth = 3

  let stream = SCStream(filter: filter, configuration: liveConfiguration, delegate: writer)
  try stream.addStreamOutput(writer, type: .screen, sampleHandlerQueue: writer.queue)
  try await stream.startCapture()
  return DesktopCapture(filter: filter, stillConfiguration: stillConfiguration, stream: stream)
}

func startAudio(excluding processes: [pid_t], distance: UnsafePointer<Float>) -> DistantAudio? {
  do {
    return try DistantAudio(excludedProcesses: processes, targetDistance: distance)
  } catch {
    FileHandle.standardError.write(Data("desktop-stream: distant audio unavailable: \(error)\n".utf8))
    return nil
  }
}

@main
struct DesktopStream {
  static func main() async {
    guard CommandLine.arguments.count == 2, let appProcess = Int32(CommandLine.arguments[1]) else {
      FileHandle.standardError.write(Data("usage: desktop-stream <app process id>\n".utf8))
      exit(2)
    }
    // Why: a helper stuck in ScreenCaptureKit never reaches the stdin loop's end, and one outliving the app keeps its tap, which silences
    // the whole Mac's sound, the next launch of Smoke Break included. Watching the app works however stuck this process is.
    appExitWatch = DispatchSource.makeProcessSource(identifier: appProcess, eventMask: .exit, queue: .global())
    appExitWatch?.setEventHandler { exit(0) }
    appExitWatch?.resume()
    if kill(appProcess, 0) != 0 { exit(0) }

    // When the app last wrote to stdin during a break; 0 between breaks, when it has no reason to.
    let lastCommand = UnsafeMutablePointer<UInt64>.allocate(capacity: 1)
    lastCommand.pointee = 0
    frozenAppWatch = DispatchSource.makeTimerSource(queue: .global())
    frozenAppWatch?.schedule(deadline: .now() + 1, repeating: 1)
    frozenAppWatch?.setEventHandler {
      let last = lastCommand.pointee
      if last != 0, DispatchTime.now().uptimeNanoseconds - last > frozenAppLimitNanoseconds { kill(appProcess, SIGKILL) }
    }
    frozenAppWatch?.resume()

    let writer = FrameWriter()
    let helperProcess = getpid()
    let distance = UnsafeMutablePointer<Float>.allocate(capacity: 1)
    distance.pointee = 0
    let sharedDistance = UnsafePointer(distance)

    // Why: the display and app list is slow to fetch, so it is ready before the click rather than after it.
    var content = prefetchContent()
    var capture: Task<DesktopCapture, Error>?
    // Why: built per break, never left idle between them: a tap that outlived a break could leave the Mac's sound muted.
    var audio: Task<DistantAudio?, Never>?

    func endBreak() async {
      // Why: audio goes first because stopping the capture can hang, and the Mac stays muted for as long as the tap is held.
      await audio?.value?.stop()
      try? await capture?.value.stream?.stopCapture()
      capture = nil
      audio = nil
      distance.pointee = 0
    }

    // Why: stdin closing means the app has gone, however it went; the helper must never outlive it and keep capturing or muting.
    while let line = readLine() {
      let parts = line.split(separator: " ")
      if lastCommand.pointee != 0 { lastCommand.pointee = DispatchTime.now().uptimeNanoseconds }
      switch parts.first {
      case "begin":
        guard parts.count == 5, let displayId = UInt32(parts[1]) else { continue }
        lastCommand.pointee = DispatchTime.now().uptimeNanoseconds
        let live = parts[4] == "live"
        let processes = parts[2].split(separator: ",").compactMap { Int32($0) }
        let knownContent = content
        // Why: detached because this loop's blocking reads hold the main actor, so a plain Task here would never run.
        if parts[3] == "sound" { audio = Task.detached { startAudio(excluding: processes + [helperProcess], distance: sharedDistance) } }
        capture = Task.detached {
          // A failed early fetch, such as before permission was granted, is retried here.
          let known = try? await knownContent.value
          let current = if let known { known } else { try await shareableContent() }
          return try await startCapture(content: current, displayId: displayId, appProcess: appProcess, live: live, writer: writer)
        }
      case "request-access":
        // Why: detached because it waits on macOS, and this loop must keep reading. A capture attempt alone never lists the app in System Settings.
        Task.detached { _ = CGRequestScreenCaptureAccess() }
      case "request-audio-access":
        Task.detached {
          do { try await requestSystemAudioAccess() } catch { FileHandle.standardError.write(Data("desktop-stream: audio access request failed: \(error)\n".utf8)) }
        }
      case "distance":
        if parts.count == 2, let value = Float(parts[1]) { distance.pointee = min(1, max(0, value)) }
      case "still":
        guard let capture else { continue }
        // Not awaited: distance updates keep flowing while the still is captured, during the dash.
        Task.detached {
          do {
            let running = try await capture.value
            let image = try await SCScreenshotManager.captureImage(contentFilter: running.filter, configuration: running.stillConfiguration)
            writer.queue.sync { writer.writeStill(image) }
          } catch {
            fail(error)
          }
        }
      case "end":
        lastCommand.pointee = 0
        await endBreak()
        content = prefetchContent()
      default:
        continue
      }
    }
    await endBreak()
    exit(0)
  }
}
