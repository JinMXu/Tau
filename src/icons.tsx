import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...props }: IconProps): SVGProps<SVGSVGElement> {
	return {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.5,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		...props,
	};
}

export function PlusIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</svg>
	);
}

export function SearchIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</svg>
	);
}

export function SettingsIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}

export function FolderIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		</svg>
	);
}

export function ChevronDownIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

export function ChevronUpIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="m18 15-6-6-6 6" />
		</svg>
	);
}

export function ChevronRightIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}

export function MoreIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<circle cx="5" cy="12" r="1.2" />
			<circle cx="12" cy="12" r="1.2" />
			<circle cx="19" cy="12" r="1.2" />
		</svg>
	);
}

export function SendIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M12 19V5" />
			<path d="m5 12 7-7 7 7" />
		</svg>
	);
}

export function StopIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect x="7" y="7" width="10" height="10" rx="2" />
		</svg>
	);
}

export function PaperclipIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
		</svg>
	);
}

export function XIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

export function CopyIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</svg>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

export function TrashIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M3 6h18" />
			<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
			<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
			<line x1="10" x2="10" y1="11" y2="17" />
			<line x1="14" x2="14" y1="11" y2="17" />
		</svg>
	);
}

export function ArchiveIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect width="20" height="5" x="2" y="3" rx="1" />
			<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
			<path d="M10 12h4" />
		</svg>
	);
}

export function RestoreIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
			<path d="M3 3v5h5" />
		</svg>
	);
}

export function RefreshIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
			<path d="M21 3v5h-5" />
			<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
			<path d="M8 16H3v5" />
		</svg>
	);
}

export function FolderOpenIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
		</svg>
	);
}

export function EditIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
			<path d="m15 5 4 4" />
		</svg>
	);
}

export function BranchIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<line x1="6" x2="6" y1="3" y2="15" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</svg>
	);
}

export function LoaderIcon(props: IconProps) {
	const { size = 16, className, ...rest } = props;
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			{...rest}
		>
			<path d="M21 12a9 9 0 1 1-6.219-8.56" />
		</svg>
	);
}

export function TerminalIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="m4 17 6-6-6-6" />
			<path d="M12 19h8" />
		</svg>
	);
}

export function FileIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		</svg>
	);
}

export function GridIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect width="7" height="7" x="3" y="3" rx="1" />
			<rect width="7" height="7" x="14" y="3" rx="1" />
			<rect width="7" height="7" x="3" y="14" rx="1" />
			<rect width="7" height="7" x="14" y="14" rx="1" />
		</svg>
	);
}

/** Sidebar visible → click collapses it (arrow points left). */
export function PanelLeftCloseIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M9 3v18" />
			<path d="m16 15-3-3 3-3" />
		</svg>
	);
}

/** Sidebar hidden → click expands it (arrow points right). */
export function PanelLeftOpenIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M9 3v18" />
			<path d="m14 9 3 3-3 3" />
		</svg>
	);
}

export function BoltIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
		</svg>
	);
}

export function SparkleIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
		</svg>
	);
}

export function ClockIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 6v6l4 2" />
		</svg>
	);
}

export function GripVerticalIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<circle cx="9" cy="6" r="1" />
			<circle cx="9" cy="12" r="1" />
			<circle cx="9" cy="18" r="1" />
			<circle cx="15" cy="6" r="1" />
			<circle cx="15" cy="12" r="1" />
			<circle cx="15" cy="18" r="1" />
		</svg>
	);
}

export function WrenchIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
		</svg>
	);
}

export function DownloadIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<path d="M7 10l5 5 5-5" />
			<path d="M12 15V3" />
		</svg>
	);
}

export function BarChartIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M3 3v18h18" />
			<path d="M7 16v-6" />
			<path d="M12 16V7" />
			<path d="M17 16v-4" />
		</svg>
	);
}

export function BrainIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
			<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
			<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
			<path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
			<path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
			<path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
			<path d="M19.938 10.5a4 4 0 0 1 .585.396" />
			<path d="M6 18a4 4 0 0 1-1.967-.516" />
			<path d="M19.967 17.484A4 4 0 0 1 18 18" />
		</svg>
	);
}

export function MinusIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M6 12.5h12" />
		</svg>
	);
}

export function MaximizeIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect x="6.5" y="6.5" width="11" height="11" />
		</svg>
	);
}

/** Overlapping window squares — shown while the window is maximized. */
export function RestoreWindowIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<rect x="8.5" y="8.5" width="9" height="9" />
			<path d="M15.5 8.5v-2h-9v9h2" />
		</svg>
	);
}

export function PinIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M12 17v5" />
			<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
		</svg>
	);
}

export function ChevronLeftIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M15 6l-6 6 6 6" />
		</svg>
	);
}

export function InfoIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5" />
			<path d="M12 8h.01" />
		</svg>
	);
}

export function EyeIcon(props: IconProps) {
	return (
		<svg {...base(props)}>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}
