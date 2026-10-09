import { JsonLd } from '@/lib/seo';
import { SiteFooter, SiteHeader } from './site-shell';

export function SimplePage({
  eyebrow,
  title,
  lead,
  children,
  jsonLd,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
  jsonLd?: Record<string, unknown>;
}) {
  return (
    <div className="cw-site cw-docs-site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {jsonLd && <JsonLd data={jsonLd} />}
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
