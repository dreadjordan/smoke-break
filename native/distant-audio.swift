// Makes everything else playing on the Mac sound as far away as the screen: a Core Audio tap silences other apps' output and
// hands it here, and it is played back through a room model driven by the viewer's distance. At distance 0 it passes through nearly unchanged.
import CoreAudio
import Foundation

// All of these are the effect at the full break distance.
let farCutoffHertz: Float = 1500
let nearCutoffHertz: Float = 20000
// Why: about 10dB down; true 15ft falloff is harsher and buried speech that should stay faintly followable.
let farGain: Float = 0.32
// A far-off speaker is close to a single point, so the stereo image narrows.
let farStereoWidth: Float = 0.35
let farRoomLevel: Float = 0.35
// Why: the audio device wakes just after the dash begins, so this eases the effect in as a sweep instead of a sudden step.
let distanceSmoothingSeconds: Float = 0.06
let roomFeedback: Float = 0.72
// Why: mutually unrelated delays stop the echoes reinforcing into a metallic ring.
let roomDelaySeconds: [Double] = [0.0297, 0.0371, 0.0411, 0.0437]

// Allocation-free so it can run on the real-time audio thread.
final class RoomProcessor {
  private let sampleRate: Float
  private let distanceStep: Float
  private let delayLines: [UnsafeMutablePointer<Float>]
  private let delayLengths: [Int]
  private let delayPositions: UnsafeMutablePointer<Int>
  private let filterState: UnsafeMutablePointer<Float>
  private var distance: Float = 0
  private let targetDistance: UnsafePointer<Float>

  init(sampleRate: Double, targetDistance: UnsafePointer<Float>) {
    self.sampleRate = Float(sampleRate)
    self.targetDistance = targetDistance
    distanceStep = 1 - exp(-1 / (distanceSmoothingSeconds * Float(sampleRate)))
    delayLengths = roomDelaySeconds.map { Int($0 * sampleRate) }
    delayLines = delayLengths.map { length in
      let line = UnsafeMutablePointer<Float>.allocate(capacity: length)
      line.initialize(repeating: 0, count: length)
      return line
    }
    delayPositions = .allocate(capacity: delayLengths.count)
    delayPositions.initialize(repeating: 0, count: delayLengths.count)
    filterState = .allocate(capacity: 4)
    filterState.initialize(repeating: 0, count: 4)
  }

  func process(_ input: UnsafePointer<Float>, inputChannels: Int, _ output: UnsafeMutablePointer<Float>, outputChannels: Int, frames: Int) {
    let cutoff = nearCutoffHertz * pow(farCutoffHertz / nearCutoffHertz, distance)
    let filterStep = 1 - exp(-2 * Float.pi * cutoff / sampleRate)
    for frame in 0..<frames {
      distance += (targetDistance.pointee - distance) * distanceStep
      let left = input[frame * inputChannels]
      let right = input[frame * inputChannels + (inputChannels > 1 ? 1 : 0)]
      let middle = (left + right) / 2
      let side = (left - right) / 2 * (1 + (farStereoWidth - 1) * distance)

      filterState[0] += (middle + side - filterState[0]) * filterStep
      filterState[1] += (filterState[0] - filterState[1]) * filterStep
      filterState[2] += (middle - side - filterState[2]) * filterStep
      filterState[3] += (filterState[2] - filterState[3]) * filterStep
      let filteredLeft = filterState[1]
      let filteredRight = filterState[3]

      var roomLeft: Float = 0
      var roomRight: Float = 0
      let roomInput = (filteredLeft + filteredRight) / 2
      for line in 0..<delayLines.count {
        let position = delayPositions[line]
        let echo = delayLines[line][position]
        delayLines[line][position] = roomInput + echo * roomFeedback
        delayPositions[line] = position + 1 == delayLengths[line] ? 0 : position + 1
        // Opposite signs on alternate lines give each ear its own echoes, so the room reads as wide.
        roomLeft += line % 2 == 0 ? echo : -echo
        roomRight += line < 2 ? echo : -echo
      }

      let gain = 1 + (farGain - 1) * distance
      let roomLevel = farRoomLevel * distance / Float(delayLines.count)
      output[frame * outputChannels] = filteredLeft * gain + roomLeft * roomLevel
      if outputChannels > 1 { output[frame * outputChannels + 1] = filteredRight * gain + roomRight * roomLevel }
      if outputChannels > 2 { for channel in 2..<outputChannels { output[frame * outputChannels + channel] = 0 } }
    }
  }
}

struct AudioFailure: Error {
  let step: String
  let status: OSStatus
}

final class DistantAudio {
  private var tap = AudioObjectID(kAudioObjectUnknown)
  private var aggregate = AudioObjectID(kAudioObjectUnknown)
  private var ioProc: AudioDeviceIOProcID?
  private let room: RoomProcessor

  // Why: our own sounds must stay close, and this helper's playback must be left out too or the tap would feed back into itself.
  init(excludedProcesses: [pid_t], targetDistance: UnsafePointer<Float>) throws {
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excludedProcesses.compactMap(audioObject))
    description.name = "Smoke Break distance"
    description.isPrivate = true
    description.muteBehavior = .mutedWhenTapped
    try check("create tap", AudioHardwareCreateProcessTap(description, &tap))

    let outputDevice = try systemObjectProperty(kAudioHardwarePropertyDefaultOutputDevice, as: AudioObjectID.self)
    let outputUID = try deviceUID(outputDevice)
    let settings: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Smoke Break distance",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
    ]
    try check("create aggregate device", AudioHardwareCreateAggregateDevice(settings as CFDictionary, &aggregate))

    room = RoomProcessor(sampleRate: try deviceSampleRate(aggregate), targetDistance: targetDistance)
    let processor = room
    let queue = DispatchQueue(label: "smokebreak.audio", qos: .userInteractive)
    try check("create audio callback", AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) { _, input, _, output, _ in
      let inputs = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
      let outputs = UnsafeMutableAudioBufferListPointer(output)
      guard let source = inputs.first, let destination = outputs.first, let sourceData = source.mData, let destinationData = destination.mData else { return }
      let inputChannels = Int(source.mNumberChannels)
      processor.process(
        sourceData.assumingMemoryBound(to: Float.self), inputChannels: inputChannels,
        destinationData.assumingMemoryBound(to: Float.self), outputChannels: Int(destination.mNumberChannels),
        frames: Int(source.mDataByteSize) / MemoryLayout<Float>.size / inputChannels)
    })
    try check("start audio", AudioDeviceStart(aggregate, ioProc))
  }

  func stop() {
    AudioDeviceStop(aggregate, ioProc)
    if let ioProc { AudioDeviceDestroyIOProcID(aggregate, ioProc) }
    AudioHardwareDestroyAggregateDevice(aggregate)
    AudioHardwareDestroyProcessTap(tap)
  }
}

private func check(_ step: String, _ status: OSStatus) throws {
  if status != noErr { throw AudioFailure(step: step, status: status) }
}

private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

private func systemObjectProperty<Value>(_ selector: AudioObjectPropertySelector, as type: Value.Type) throws -> Value {
  try objectProperty(AudioObjectID(kAudioObjectSystemObject), selector, as: type)
}

private func objectProperty<Value>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, as type: Value.Type) throws -> Value {
  var propertyAddress = address(selector)
  var size = UInt32(MemoryLayout<Value>.size)
  let value = UnsafeMutablePointer<Value>.allocate(capacity: 1)
  defer { value.deallocate() }
  try check("read audio property", AudioObjectGetPropertyData(object, &propertyAddress, 0, nil, &size, value))
  return value.pointee
}

private func deviceUID(_ device: AudioObjectID) throws -> String {
  try objectProperty(device, kAudioDevicePropertyDeviceUID, as: CFString.self) as String
}

private func deviceSampleRate(_ device: AudioObjectID) throws -> Double {
  try objectProperty(device, kAudioDevicePropertyNominalSampleRate, as: Float64.self)
}

// The audio object for a process, or nil if it has never touched audio and so has nothing to exclude.
private func audioObject(_ process: pid_t) -> AudioObjectID? {
  var propertyAddress = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
  var pid = process
  var object = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &propertyAddress, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
  return status == noErr && object != kAudioObjectUnknown ? object : nil
}
