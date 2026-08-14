import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4" cy="3" r="2" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="4" cy="13" r="2" />
      <path d="M4 5v6M6 9c4 0 6-1 6-2V7" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </Icon>
  )
}

export function ChevronIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </Icon>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" />
      <path d="M3 10.5V4.2C3 3.5 3.5 3 4.2 3h6.3" fill="none" stroke="currentColor" />
    </Icon>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 5V2.5l-1.2 1.2A5.5 5.5 0 1 0 13.2 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </Icon>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 1.5h5L12.5 5v9.5h-9z" fill="none" stroke="currentColor" />
      <path d="M8.5 1.5V5h4" fill="none" stroke="currentColor" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </Icon>
  )
}

export function CommentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5h11v8h-6l-3.5 2v-2H2.5z" fill="none" stroke="currentColor" />
    </Icon>
  )
}
