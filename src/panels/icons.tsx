type IconProps = { size?: number }

const base = { viewBox: '0 0 24 24', fill: 'currentColor' } as const

export function ObjectModeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <g transform="matrix(1,0,0,1,1,-1)">
        <path d="M2,16L3,16L3,21L8,21L8,22L2,22L2,16ZM8,4L8,5L3,5L3,10L2,10L2,4L8,4ZM20,10L19,10L19,5L14,5L14,4L20,4L20,10ZM14,22L14,21L19,21L19,16L20,16L20,22L14,22ZM17,7L17,19L5,19L5,7L17,7Z" />
      </g>
    </svg>
  )
}

export function PivotModeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <path d="M12,1L12,7M12,17L12,23M1,12L7,12M17,12L23,12" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function EditModeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <g transform="matrix(0.666667,0,0,0.666667,2.333333,2.333333)">
        <path d="M2.5,8.5L1,8.5L1,1L8.5,1L8.5,2.5L20.5,2.5L20.5,-2L31,-2L31,8.5L26.5,8.5L26.5,20.5L28,20.5L28,28L20.5,28L20.5,26.5L8.5,26.5L8.5,28L1,28L1,20.5L2.5,20.5L2.5,8.5ZM7,2.5L2.5,2.5L2.5,7L7,7L7,2.5ZM20.5,3.833L8.5,3.833L8.5,8.5L3.833,8.5L3.833,20.5L8.5,20.5L8.5,25.167L20.5,25.167L20.5,20.5L25.167,20.5L25.167,8.5L20.5,8.5L20.5,3.833ZM7,22L2.5,22L2.5,26.5L7,26.5L7,22ZM26.5,22L22,22L22,26.5L26.5,26.5L26.5,22Z" />
      </g>
    </svg>
  )
}

export function VertexIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M3,12L1,12L1,7L4,7L8,3L21,3L21,16L16,21L3,21L3,12ZM4,12L4,20L15.5,20L20,15.5L20,4L8.5,4L5.5,7L6,7L6,12L4,12Z" />
    </svg>
  )
}

export function EdgeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M13.5,21L3,21L3,8L8,3L21,3L21,16L17.5,19.5L17.5,23L13.5,23L13.5,21ZM17.5,18L20,15.5L20,4L8.5,4L4,8.5L4,20L13.5,20L13.5,7L17.5,7L17.5,18Z" />
    </svg>
  )
}

export function FaceIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M17,20L17,23L1,23L1,7L4,7L8,3L21,3L21,16L17,20ZM17,18.5L20,15.5L20,4L8.5,4L5.5,7L17,7L17,18.5Z" />
    </svg>
  )
}

export function VisibleTrueIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M607.5-372.5Q660-425 660-500t-52.5-127.5Q555-680 480-680t-127.5 52.5Q300-575 300-500t52.5 127.5Q405-320 480-320t127.5-52.5Zm-204-51Q372-455 372-500t31.5-76.5Q435-608 480-608t76.5 31.5Q588-545 588-500t-31.5 76.5Q525-392 480-392t-76.5-31.5ZM214-281.5Q94-363 40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200q-146 0-266-81.5ZM480-500Zm207.5 160.5Q782-399 832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-280q113 0 207.5-59.5Z" />
    </svg>
  )
}

export function VisibleFalseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="m644-428-58-58q9-47-27-88t-93-32l-58-58q17-8 34.5-12t37.5-4q75 0 127.5 52.5T660-500q0 20-4 37.5T644-428Zm128 126-58-56q38-29 67.5-63.5T832-500q-50-101-143.5-160.5T480-720q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t90-8.5q151 0 269 83.5T920-500q-23 59-60.5 109.5T772-302Zm20 246L624-222q-35 11-70.5 16.5T480-200q-151 0-269-83.5T40-500q21-53 53-98.5t73-81.5L56-792l56-56 736 736-56 56ZM222-624q-29 26-53 57t-41 67q50 101 143.5 160.5T480-280q20 0 39-2.5t39-5.5l-36-38q-11 3-21 4.5t-21 1.5q-75 0-127.5-52.5T300-500q0-11 1.5-21t4.5-21l-84-82Zm319 93Zm-151 75Z" />
    </svg>
  )
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z" />
    </svg>
  )
}

export function LockedIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill="currentColor">
      <path d="M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm0-80h480v-400H240v400Zm296.5-143.5Q560-327 560-360t-23.5-56.5Q513-440 480-440t-56.5 23.5Q400-393 400-360t23.5 56.5Q447-280 480-280t56.5-23.5ZM360-640h240v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80ZM240-160v-400 400Z" />
    </svg>
  )
}

export function UnlockedIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill="currentColor">
      <path d="M240-160h480v-400H240v400Zm296.5-143.5Q560-327 560-360t-23.5-56.5Q513-440 480-440t-56.5 23.5Q400-393 400-360t23.5 56.5Q447-280 480-280t56.5-23.5ZM240-160v-400 400Zm0 80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h280v-80q0-83 58.5-141.5T720-920q83 0 141.5 58.5T920-720h-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80h120q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Z" />
    </svg>
  )
}

/** Four small corner brackets touching all four edges of the 24x24 viewBox — used by
 *  `IslandSelectIcon` so it shares the same "framed" look the visibility icons used to. */
function CornerBrackets() {
  return (
    <>
      <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      <g transform="matrix(0,1,-1,0,24,0)">
        <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      </g>
      <g transform="matrix(-1,0,-0,-1,24,24)">
        <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      </g>
      <g transform="matrix(0,-1,1,0,0,24)">
        <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      </g>
    </>
  )
}

export function IslandSelectIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <CornerBrackets />
      <g transform="matrix(1.06066,-1.06066,0.785674,0.785674,-8.073976,10.446839)">
        <path d="M7,8L7,14.3L14.333,14.3L14.333,17L5,17L5,8L7,8Z" />
      </g>
    </svg>
  )
}

export function LoopCutIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M16,21L3,21L3,8L8,3L21,3L21,16L16,21ZM13,4L8.5,4L4.5,8L9,8L13,4ZM9,9L4,9L4,20L9,20L9,9ZM10,20L15,20L15,9L10,9L10,20ZM10.5,8L15,8L19,4L14.5,4L10.5,8ZM16,9L16,19.5L20,15.5L20,5L16,9Z" />
    </svg>
  )
}

export function RectPrimitiveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" strokeWidth="1.1" />
      <path d="M15,3L15,21" strokeWidth="1" />
      <path d="M8.5,3L8.5,21" strokeWidth="1" />
      <path d="M3,15L21,15" strokeWidth="1" />
      <path d="M3,8.5L21,8.5" strokeWidth="1" />
    </svg>
  )
}

export function CirclePrimitiveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12,2L19.071,4.929L22,12L19.071,19.071L12,22L4.929,19.071L2,12L4.929,4.929L12,2Z" strokeWidth="1" />
      <path d="M3,12L21,12" strokeWidth="1" />
      <path d="M12,3L12,21" strokeWidth="1" />
      <path d="M6,6L18,18" strokeWidth="1" />
      <path d="M6,18L18,6" strokeWidth="1" />
    </svg>
  )
}

export function HairPathPrimitiveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <g transform="matrix(0.033333,0,0,0.033333,-11.333333,-4.666667)">
        <path d="M610,200L610,400L670,540L770,680L1000,800L700,770L520,635L400,440L400,200L610,200Z" strokeWidth="30" />
        <path d="M400,440L610,400" strokeWidth="30" />
        <g transform="matrix(1,0,0,1,10,150)">
          <path d="M510,485L660,390" strokeWidth="30" />
        </g>
        <g transform="matrix(1,0,0,1,70,290)">
          <path d="M630,480L700,390" strokeWidth="30" />
        </g>
      </g>
    </svg>
  )
}

export function PathPrimitiveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3,19 C3,19 7,19 9,13 C11,7 13,5 15,5 C17,5 17,9 21,9" strokeWidth="1.5" />
      <circle cx="3" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="9" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="21" cy="9" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function RingCutIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="9.5" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="5.5" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function KnifeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M13.16,3L21,3L21,16L16,21L13.646,21C13.453,21.441 13.012,21.75 12.5,21.75C11.988,21.75 11.547,21.441 11.354,21L3,21L3,8L8,3L10.84,3C11.025,2.541 11.475,2.217 12,2.217C12.525,2.217 12.975,2.541 13.16,3ZM10.869,4L8.5,4L4.5,8L6.354,8C6.547,7.559 6.988,7.25 7.5,7.25C7.578,7.25 7.655,7.257 7.729,7.271L10.914,4.086C10.898,4.058 10.883,4.029 10.869,4ZM6.354,9L4,9L4,20L11.354,20C11.444,19.795 11.588,19.618 11.767,19.488L7.336,9.739C6.895,9.681 6.526,9.393 6.354,9ZM8.233,9.512L12.664,19.261C13.105,19.319 13.474,19.607 13.646,20L15,20L15,9L8.646,9C8.556,9.205 8.412,9.382 8.233,9.512ZM8.646,8L15,8L19,4L13.131,4C12.93,4.423 12.499,4.717 12,4.717C11.932,4.717 11.865,4.711 11.799,4.701L8.598,7.902C8.615,7.934 8.631,7.967 8.646,8ZM16,9L16,19.5L20,15.5L20,5L16,9Z" />
    </svg>
  )
}

export function ExtrudeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <rect x="3" y="12" width="18" height="9" />
      <path d="M3,3L6,3L6,4L4,4L4,6L3,6L3,3ZM3,8L4,8L4,11L3,11L3,8ZM16,3L16,4L13,4L13,3L16,3ZM11,3L11,4L8,4L8,3L11,3ZM21,3L21,6L20,6L20,4L18,4L18,3L21,3ZM21,8L21,11L20,11L20,8L21,8Z" />
      <g transform="matrix(1,0,0,1,-8,0)">
        <path d="M11.5,2C12.328,2 13,2.672 13,3.5C13,4.328 12.328,5 11.5,5C10.672,5 10,4.328 10,3.5C10,2.672 10.672,2 11.5,2ZM28.5,2C29.328,2 30,2.672 30,3.5C30,4.328 29.328,5 28.5,5C27.672,5 27,4.328 27,3.5C27,2.672 27.672,2 28.5,2Z" />
      </g>
      <g transform="matrix(1,0,0,1,-8,17)">
        <path d="M11.5,2C12.328,2 13,2.672 13,3.5C13,4.328 12.328,5 11.5,5C10.672,5 10,4.328 10,3.5C10,2.672 10.672,2 11.5,2ZM28.5,2C29.328,2 30,2.672 30,3.5C30,4.328 29.328,5 28.5,5C27.672,5 27,4.328 27,3.5C27,2.672 27.672,2 28.5,2Z" />
      </g>
      <g transform="matrix(1,0,0,1,-8,8.5)">
        <path d="M11.5,2C12.328,2 13,2.672 13,3.5C13,4.328 12.328,5 11.5,5C10.672,5 10,4.328 10,3.5C10,2.672 10.672,2 11.5,2ZM28.5,2C29.328,2 30,2.672 30,3.5C30,4.328 29.328,5 28.5,5C27.672,5 27,4.328 27,3.5C27,2.672 27.672,2 28.5,2Z" />
      </g>
    </svg>
  )
}

const wide = { viewBox: '0 -960 960 960', fill: 'currentColor' } as const

export function ProjectOpenIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M160-160q-33 0-56.5-23.5T80-240v-400q0-33 23.5-56.5T160-720h240l80-80h320q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm73-280h207v-207L233-440Zm-73-40 160-160H160v160Zm0 120v120h640v-480H520v280q0 33-23.5 56.5T440-360H160Zm280-160Z" />
    </svg>
  )
}

export function ProjectSaveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M840-680v480q0 33-23.5 56.5T760-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h480l160 160Zm-80 34L646-760H200v560h560v-446ZM565-275q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35ZM240-560h360v-160H240v160Zm-40-86v446-560 114Z" />
    </svg>
  )
}

export function UndoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z" />
    </svg>
  )
}

export function RedoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M396-200q-97 0-166.5-63T160-420q0-94 69.5-157T396-640h252L544-744l56-56 200 200-200 200-56-56 104-104H396q-63 0-109.5 40T240-420q0 60 46.5 100T396-280h284v80H396Z" />
    </svg>
  )
}

export function ObjImportIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...wide}>
      <path d="M440-200h80v-167l64 64 56-57-160-160-160 160 57 56 63-63v167ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z" />
    </svg>
  )
}

export function DissolveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4,12L9,12M15,12L20,12" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ReferenceImageIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <g transform="matrix(0.027778,0,0,0.027778,-1.333333,25.333333)">
        <path d="M200,-120C178,-120 159.167,-127.833 143.5,-143.5C127.833,-159.167 120,-178 120,-200L120,-760C120,-782 127.833,-800.833 143.5,-816.5C159.167,-832.167 178,-840 200,-840L520,-840L520,-768L192,-768L192,-192L768,-192L768,-520L840,-520L840,-200C840,-178 832.167,-159.167 816.5,-143.5C800.833,-127.833 782,-120 760,-120L200,-120ZM264,-264L696,-264C696,-264 670.498,-319.091 624,-336C558,-360 402,-360 336,-336C289.502,-319.091 264,-264 264,-264ZM680,-600L680,-680L600,-680L600,-760L680,-760L680,-840L760,-840L760,-760L840,-760L840,-680L760,-680L760,-600L680,-600Z" />
      </g>
      <g transform="matrix(0.875,0,0,0.875,1.5,2.75)">
        <circle cx="12" cy="10" r="4" />
      </g>
    </svg>
  )
}

export function PlayIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7,5 L7,19 L19,12 Z" />
    </svg>
  )
}

export function PauseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7,5 L7,19 L10,19 L10,5 Z M14,5 L14,19 L17,19 L17,5 Z" />
    </svg>
  )
}

export function StopIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" />
    </svg>
  )
}

export function JumpToStartIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5,5 L5,19 L7.5,19 L7.5,5 Z M19,5 L7.5,12 L19,19 Z" />
    </svg>
  )
}

export function JumpToEndIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19,5 L19,19 L16.5,19 L16.5,5 Z M5,5 L16.5,12 L5,19 Z" />
    </svg>
  )
}

export function JumpToPrevFrameIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      {/* diamond left, triangle pointing left right */}
      <path d="M7,6 L12,12 L7,18 L2,12 Z M20,7 L20,17 L14,12 Z" />
    </svg>
  )
}

export function JumpToNextFrameIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      {/* triangle pointing right left, diamond right */}
      <path d="M4,7 L4,17 L10,12 Z M17,6 L22,12 L17,18 L12,12 Z" />
    </svg>
  )
}

export function PlayheadIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ fillRule: 'evenodd', clipRule: 'evenodd' }}>
      <g transform="matrix(1.166667,0,0,1,-2,-2)">
        <path d="M18,2L18,14L12,20L6,14L6,2L18,2Z" />
      </g>
    </svg>
  )
}

export function AddKeyframeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ fillRule: 'evenodd', clipRule: 'evenodd' }}>
      <g transform="matrix(1.2,0,0,1.166667,-4.2,-0)">
        <path d="M16,6L11,12L16,18L21,12L16,6Z" />
      </g>
      <g transform="matrix(1.142857,0,0,1,0.714286,-5)">
        <path d="M4.625,13L2,13L2,11L4.625,11L4.625,8L6.375,8L6.375,11L9,11L9,13L6.375,13L6.375,16L4.625,16L4.625,13Z" />
      </g>
      <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      <g transform="matrix(0,1,-1,0,24,0)">
        <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      </g>
      <g transform="matrix(-1,0,-0,-1,24,24)">
        <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      </g>
      <g transform="matrix(0,-1,1,0,0,24)">
        <path d="M5,1L1,1L1,5L2,5L2,2L5,2L5,1Z" />
      </g>
    </svg>
  )
}
