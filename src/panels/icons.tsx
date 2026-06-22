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
