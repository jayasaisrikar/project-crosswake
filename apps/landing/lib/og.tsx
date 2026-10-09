import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Social preview cards, drawn in the landing page's style: black, Geist, the green accent.
export const ogSize = { width: 1200, height: 630 };
export const ogContentType = 'image/png';

// Static Geist (the variable font renders uneven word spacing in the image renderer).
const font = (weight: 400 | 600) =>
  readFile(join(process.cwd(), `assets/fonts/geist-${weight}.woff`)).catch(() => null);

export async function ogImage({
  eyebrow,
  title,
  subtitle,
  stats,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  stats?: [string, string][];
}) {
  const [logo, bg, regular, bold] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand/logo-mark.png')),
    readFile(join(process.cwd(), 'public/bg/hero.jpg')).catch(() => null),
    font(400),
    font(600),
  ]);
  const fonts = [
    regular && { name: 'Geist', data: regular, weight: 400 as const, style: 'normal' as const },
    bold && { name: 'Geist', data: bold, weight: 600 as const, style: 'normal' as const },
  ].filter(Boolean) as { name: string; data: Buffer; weight: 400 | 600; style: "normal" }[];
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: '#000',
          color: '#f2f2ee',
          fontFamily: 'Geist',
          position: 'relative',
        }}
      >
        {bg && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/jpeg;base64,${bg.toString('base64')}`}
            width={1200}
            height={630}
            style={{ position: 'absolute', top: 0, left: 0, width: 1200, height: 630, objectFit: 'cover', opacity: 0.5 }}
            alt=""
          />
        )}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            display: 'flex',
            background: 'linear-gradient(90deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0.3) 100%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '64px 72px',
          }}
        >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/png;base64,${logo.toString('base64')}`} width={52} height={52} alt="" />
          <div style={{ display: 'flex', fontSize: 26, letterSpacing: 8 }}>
            CROSSW<span style={{ color: '#2ee6c5' }}>A</span>KE
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 900 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 22, color: '#7ac74f', letterSpacing: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: 10, background: '#a1cf6b' }} />
            {eyebrow.toUpperCase()}
          </div>
          <div style={{ display: 'flex', fontSize: title.length > 28 ? 68 : 84, fontWeight: 600, lineHeight: 1.02, letterSpacing: -3 }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ display: 'flex', fontSize: 28, lineHeight: 1.4, color: '#b8b8b2' }}>{subtitle}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 48 }}>
            {(stats ?? []).map(([v, l]) => (
              <div key={l} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', fontSize: 40, fontWeight: 600 }}>{v}</div>
                <div style={{ display: 'flex', fontSize: 18, color: '#9a9a94' }}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', fontSize: 18, color: '#9a9a94' }}>Paper signals · not financial advice</div>
        </div>
        </div>
      </div>
    ),
    { ...ogSize, fonts: fonts.length ? fonts : undefined },
  );
}
