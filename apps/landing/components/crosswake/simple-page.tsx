import { SiteFooter, SiteHeader } from './site-shell';

export function SimplePage({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <div className="cw-site cw-docs-site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="sl-page">
        <p className="sl-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="sl-lead">{lead}</p>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
