const paths: Record<string, React.ReactNode> = {
  check: <path d="M4 12.5l5 5L20 6.5" />,
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  file: (
    <>
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  logo: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7 6V3M12 6V3M17 6V3M7 21v-3M12 21v-3M17 21v-3" />
      <path d="M9 12h6" />
    </>
  ),
};

export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
