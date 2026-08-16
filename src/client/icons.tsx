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

export function AddCommentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 3.5h11v8h-6l-3.5 2v-2H2.5z" fill="none" stroke="currentColor" />
      <path d="M8 5.5v4M6 7.5h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </Icon>
  )
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 5h11v8.5h-11zM1.5 2.5h13V5h-13zM6 8h4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
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

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 8 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function CommitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.5 8h4m5 0h4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
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

export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 11.5-.5 2 2-.5 7.8-7.8-1.5-1.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m9.8 4.7 1.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
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

export function RepositoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 2.5h11v11h-11zM5 2.5v11M7.5 5h3.5M7.5 8h3.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </Icon>
  )
}

export function RestoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 5H2V2.5M2.4 5a5.7 5.7 0 1 1-.1 5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function ThemeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
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

export function WrapIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4h12M2 8h9a2 2 0 0 1 0 4H8m2-2-2 2 2 2M2 12h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}
