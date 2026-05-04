// src/modules/school/exams/card-templates.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pre-built HTML templates for Admit Cards and Report Cards.
// Templates use {{placeholder}} syntax for data injection.
// Schools pick a templateKey; the HTML is never stored in the DB —
// only the key is persisted. This allows updating templates without
// touching school data.
//
// Available placeholders:
//   ADMIT CARD:  {{studentName}} {{rollNumber}} {{className}} {{sectionName}}
//                {{examName}} {{schoolName}} {{schoolLogo}} {{currentDate}}
//                {{timetableTable}} {{academicYear}}
//   REPORT CARD: all of above PLUS {{percentage}} {{marksTable}}
//                {{totalObtained}} {{totalMax}} {{gradeLabel}} {{passStatus}}
// ─────────────────────────────────────────────────────────────────────────────

export interface CardTemplate {
  key: string;
  name: string;
  description: string;
  thumbnail: string; // CSS class or color hint for the picker UI
  htmlContent: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED PRINT BASE STYLES (injected into every template)
// ─────────────────────────────────────────────────────────────────────────────
const BASE_PRINT_STYLES = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:wght@700;800&display=swap');
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: 'Inter', sans-serif; background: #fff; color: #1a1a2e; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @page { margin: 12mm; size: A4; }
      @media print {
        body { margin: 0; }
        .page-break { page-break-after: always; }
      }
      table { border-collapse: collapse; width: 100%; }
      th, td { padding: 10px 14px; text-align: left; border: 1px solid #e2e8f0; font-size: 13px; }
      th { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
      .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; margin-bottom: 3px; }
      .value { font-size: 15px; font-weight: 700; }
    </style>
  `;

// ─────────────────────────────────────────────────────────────────────────────
// ADMIT CARD TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const ADMIT_CLASSIC: CardTemplate = {
  key: "ADMIT_CLASSIC",
  name: "Classic Formal",
  description:
    "Traditional bordered layout with school logo header. Professional and widely accepted.",
  thumbnail: "classic",
  htmlContent: `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admit Card — {{examName}}</title>
    ${BASE_PRINT_STYLES}
    <style>
      .card { max-width: 740px; margin: 0 auto; border: 2px solid #1e3a5f; border-radius: 8px; overflow: hidden; }
      .header { background: #1e3a5f; color: #fff; padding: 24px 28px; display: flex; align-items: center; gap: 20px; }
      .header img { width: 72px; height: 72px; object-fit: contain; border-radius: 6px; background: rgba(255,255,255,0.1); }
      .header-text h1 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 800; margin-bottom: 4px; }
      .header-text p { font-size: 13px; opacity: 0.8; }
      .exam-banner { background: #f0f4ff; border-bottom: 2px solid #1e3a5f; padding: 12px 28px; display: flex; justify-content: space-between; align-items: center; }
      .exam-banner .exam-name { font-size: 17px; font-weight: 800; color: #1e3a5f; }
      .exam-banner .admit-label { background: #1e3a5f; color: #fff; padding: 5px 16px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
      .body { padding: 24px 28px; }
      .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 24px; }
      .info-item { border-left: 3px solid #1e3a5f; padding-left: 12px; }
      .timetable-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #1e3a5f; margin-bottom: 10px; border-bottom: 2px solid #1e3a5f; padding-bottom: 6px; }
      table th { background: #1e3a5f; color: #fff; border-color: #1e3a5f; }
      table tr:nth-child(even) td { background: #f8fafc; }
      .footer { padding: 16px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #64748b; }
      .sig-line { border-top: 1.5px solid #334155; width: 140px; padding-top: 6px; text-align: center; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        {{#if schoolLogo}}<img src="{{schoolLogo}}" alt="School Logo" />{{/if}}
        <div class="header-text">
          <h1>{{schoolName}}</h1>
          <p>Official Admit Card · Academic Year {{academicYear}}</p>
        </div>
      </div>
      <div class="exam-banner">
        <span class="exam-name">{{examName}}</span>
        <span class="admit-label">Admit Card</span>
      </div>
      <div class="body">
        <div class="info-grid">
          <div class="info-item">
            <div class="label">Student Name</div>
            <div class="value">{{studentName}}</div>
          </div>
          <div class="info-item">
            <div class="label">Class &amp; Section</div>
            <div class="value">{{className}} – {{sectionName}}</div>
          </div>
          <div class="info-item">
            <div class="label">Roll Number</div>
            <div class="value">{{rollNumber}}</div>
          </div>
          <div class="info-item">
            <div class="label">Issued On</div>
            <div class="value">{{currentDate}}</div>
          </div>
        </div>
        <div class="timetable-title">Examination Timetable</div>
        {{timetableTable}}
      </div>
      <div class="footer">
        <span>This card must be produced at the time of examination.</span>
        <div class="sig-line">Authorised Signatory</div>
      </div>
    </div>
  </body>
  </html>`,
};

const ADMIT_MODERN: CardTemplate = {
  key: "ADMIT_MODERN",
  name: "Modern Gradient",
  description:
    "Contemporary design with gradient accent and card-based layout.",
  thumbnail: "modern",
  htmlContent: `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admit Card — {{examName}}</title>
    ${BASE_PRINT_STYLES}
    <style>
      .card { max-width: 740px; margin: 0 auto; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
      .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 28px 32px; position: relative; overflow: hidden; }
      .header::before { content: ''; position: absolute; top: -40px; right: -40px; width: 200px; height: 200px; border-radius: 50%; background: rgba(255,255,255,0.08); }
      .header::after { content: ''; position: absolute; bottom: -60px; left: 20%; width: 160px; height: 160px; border-radius: 50%; background: rgba(255,255,255,0.06); }
      .header-inner { position: relative; display: flex; align-items: center; gap: 20px; }
      .logo-wrap { width: 68px; height: 68px; border-radius: 10px; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; }
      .logo-wrap img { width: 100%; height: 100%; object-fit: contain; }
      .logo-initial { font-size: 26px; font-weight: 800; color: #fff; }
      .school-name { font-size: 20px; font-weight: 800; margin-bottom: 3px; }
      .school-sub { font-size: 13px; opacity: 0.82; }
      .admit-ribbon { background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); border-radius: 20px; padding: 4px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; display: inline-block; margin-top: 8px; backdrop-filter: blur(8px); }
      .exam-strip { background: #f8f7ff; padding: 14px 32px; border-bottom: 1px solid #e8e4f8; display: flex; justify-content: space-between; align-items: center; }
      .exam-strip .name { font-size: 17px; font-weight: 800; color: #5b21b6; }
      .exam-strip .date { font-size: 12px; color: #64748b; font-weight: 500; }
      .body { padding: 28px 32px; }
      .info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 28px; }
      .info-card { background: #f8faff; border: 1px solid #e8e4f8; border-radius: 8px; padding: 14px; }
      .info-card .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #7c3aed; margin-bottom: 4px; }
      .info-card .value { font-size: 15px; font-weight: 700; color: #1e1b4b; }
      .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #7c3aed; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
      .section-title::after { content: ''; flex: 1; height: 1px; background: linear-gradient(to right, #c4b5fd, transparent); }
      table th { background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; border-color: #7c3aed; }
      table tr:nth-child(even) td { background: #faf8ff; }
      td { border-color: #e8e4f8; }
      .footer { padding: 16px 32px; background: #faf8ff; border-top: 1px solid #e8e4f8; display: flex; justify-content: space-between; align-items: center; }
      .footer-note { font-size: 11px; color: #94a3b8; }
      .sig-line { border-top: 1.5px solid #7c3aed; width: 140px; padding-top: 6px; text-align: center; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #7c3aed; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <div class="header-inner">
          <div class="logo-wrap">
            {{#if schoolLogo}}<img src="{{schoolLogo}}" alt="Logo" />{{else}}<span class="logo-initial">{{schoolInitial}}</span>{{/if}}
          </div>
          <div>
            <div class="school-name">{{schoolName}}</div>
            <div class="school-sub">Academic Year {{academicYear}}</div>
            <div class="admit-ribbon">✦ Admit Card</div>
          </div>
        </div>
      </div>
      <div class="exam-strip">
        <span class="name">{{examName}}</span>
        <span class="date">Issued: {{currentDate}}</span>
      </div>
      <div class="body">
        <div class="info-grid">
          <div class="info-card">
            <div class="label">Student Name</div>
            <div class="value">{{studentName}}</div>
          </div>
          <div class="info-card">
            <div class="label">Roll Number</div>
            <div class="value">{{rollNumber}}</div>
          </div>
          <div class="info-card">
            <div class="label">Class</div>
            <div class="value">{{className}}</div>
          </div>
          <div class="info-card">
            <div class="label">Section</div>
            <div class="value">{{sectionName}}</div>
          </div>
        </div>
        <div class="section-title">Examination Schedule</div>
        {{timetableTable}}
      </div>
      <div class="footer">
        <span class="footer-note">Present this card at the examination hall.</span>
        <div class="sig-line">Principal / Coordinator</div>
      </div>
    </div>
  </body>
  </html>`,
};

const ADMIT_MINIMAL: CardTemplate = {
  key: "ADMIT_MINIMAL",
  name: "Clean Minimal",
  description:
    "Ultra-clean typographic layout. Perfect for schools preferring simplicity.",
  thumbnail: "minimal",
  htmlContent: `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admit Card — {{examName}}</title>
    ${BASE_PRINT_STYLES}
    <style>
      .card { max-width: 700px; margin: 0 auto; padding: 40px; }
      .top-rule { height: 4px; background: #0f172a; margin-bottom: 32px; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
      .school-block h1 { font-size: 24px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; margin-bottom: 3px; }
      .school-block p { font-size: 13px; color: #64748b; }
      .admit-tag { background: #0f172a; color: #fff; padding: 6px 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; align-self: flex-start; }
      .exam-name { font-size: 19px; font-weight: 800; color: #0f172a; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; }
      .info-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-bottom: 32px; border: 1px solid #e2e8f0; }
      .info-cell { padding: 14px 16px; border-right: 1px solid #e2e8f0; }
      .info-cell:last-child { border-right: none; }
      .info-cell .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 5px; }
      .info-cell .value { font-size: 14px; font-weight: 700; color: #0f172a; }
      .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 12px; }
      table th { background: #f8fafc; color: #475569; border-color: #e2e8f0; }
      table td { border-color: #e2e8f0; }
      .bottom { margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end; }
      .note { font-size: 11px; color: #94a3b8; max-width: 300px; line-height: 1.6; }
      .sig { text-align: right; }
      .sig-line { border-top: 1px solid #0f172a; width: 150px; padding-top: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; text-align: center; }
      .bottom-rule { height: 4px; background: #0f172a; margin-top: 32px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="top-rule"></div>
      <div class="header">
        <div class="school-block">
          <h1>{{schoolName}}</h1>
          <p>Academic Year {{academicYear}} · {{currentDate}}</p>
        </div>
        <div class="admit-tag">Admit Card</div>
      </div>
      <div class="exam-name">{{examName}}</div>
      <div class="info-row">
        <div class="info-cell">
          <div class="label">Student</div>
          <div class="value">{{studentName}}</div>
        </div>
        <div class="info-cell">
          <div class="label">Class</div>
          <div class="value">{{className}} – {{sectionName}}</div>
        </div>
        <div class="info-cell">
          <div class="label">Roll No.</div>
          <div class="value">{{rollNumber}}</div>
        </div>
        <div class="info-cell">
          <div class="label">Issued</div>
          <div class="value">{{currentDate}}</div>
        </div>
      </div>
      <div class="section-title">Timetable</div>
      {{timetableTable}}
      <div class="bottom">
        <p class="note">This admit card must be presented at the examination hall. No student will be permitted without it.</p>
        <div class="sig">
          <div class="sig-line">Authorised Signatory</div>
        </div>
      </div>
      <div class="bottom-rule"></div>
    </div>
  </body>
  </html>`,
};

// ─────────────────────────────────────────────────────────────────────────────
// REPORT CARD TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_CLASSIC: CardTemplate = {
  key: "REPORT_CLASSIC",
  name: "Classic Formal",
  description:
    "Traditional bordered layout with full marks breakdown. Standard and trusted.",
  thumbnail: "classic",
  htmlContent: `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Report Card — {{examName}}</title>
    ${BASE_PRINT_STYLES}
    <style>
      .card { max-width: 740px; margin: 0 auto; border: 2px solid #1e3a5f; border-radius: 8px; overflow: hidden; }
      .header { background: #1e3a5f; color: #fff; padding: 24px 28px; display: flex; align-items: center; gap: 20px; }
      .header img { width: 72px; height: 72px; object-fit: contain; border-radius: 6px; background: rgba(255,255,255,0.1); }
      .header-text h1 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 800; margin-bottom: 4px; }
      .header-text p { font-size: 13px; opacity: 0.8; }
      .report-banner { background: #f0f4ff; border-bottom: 2px solid #1e3a5f; padding: 12px 28px; display: flex; justify-content: space-between; align-items: center; }
      .report-banner .exam-name { font-size: 17px; font-weight: 800; color: #1e3a5f; }
      .report-banner .report-label { background: #1e3a5f; color: #fff; padding: 5px 16px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
      .body { padding: 24px 28px; }
      .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 24px; }
      .info-item { border-left: 3px solid #1e3a5f; padding-left: 12px; }
      .section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #1e3a5f; margin-bottom: 10px; border-bottom: 2px solid #1e3a5f; padding-bottom: 6px; margin-top: 24px; }
      table th { background: #1e3a5f; color: #fff; border-color: #1e3a5f; }
      table tr:nth-child(even) td { background: #f8fafc; }
      .result-box { margin-top: 20px; background: #f0f4ff; border: 2px solid #1e3a5f; border-radius: 6px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; }
      .result-box .big { font-size: 28px; font-weight: 800; color: #1e3a5f; }
      .result-box .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; font-weight: 600; margin-bottom: 2px; }
      .result-box .pass { color: #16a34a; font-size: 18px; font-weight: 800; }
      .result-box .fail { color: #dc2626; font-size: 18px; font-weight: 800; }
      .footer { padding: 16px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #64748b; }
      .sig-line { border-top: 1.5px solid #334155; width: 140px; padding-top: 6px; text-align: center; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        {{#if schoolLogo}}<img src="{{schoolLogo}}" alt="School Logo" />{{/if}}
        <div class="header-text">
          <h1>{{schoolName}}</h1>
          <p>Report Card · Academic Year {{academicYear}}</p>
        </div>
      </div>
      <div class="report-banner">
        <span class="exam-name">{{examName}}</span>
        <span class="report-label">Report Card</span>
      </div>
      <div class="body">
        <div class="info-grid">
          <div class="info-item">
            <div class="label">Student Name</div>
            <div class="value">{{studentName}}</div>
          </div>
          <div class="info-item">
            <div class="label">Class &amp; Section</div>
            <div class="value">{{className}} – {{sectionName}}</div>
          </div>
          <div class="info-item">
            <div class="label">Roll Number</div>
            <div class="value">{{rollNumber}}</div>
          </div>
        </div>
        <div class="section-title">Marks Statement</div>
        {{marksTable}}
        <div class="result-box">
          <div>
            <div class="label">Overall Percentage</div>
            <div class="big">{{percentage}}%</div>
          </div>
          <div>
            <div class="label">Total Marks</div>
            <div class="big">{{totalObtained}} / {{totalMax}}</div>
          </div>
          <div>
            <div class="label">Result</div>
            <div class="{{passStatusClass}}">{{passStatus}}</div>
          </div>
          <div>
            <div class="label">Grade</div>
            <div class="big">{{gradeLabel}}</div>
          </div>
        </div>
      </div>
      <div class="footer">
        <span>Issued on {{currentDate}}</span>
        <div class="sig-line">Class Teacher / Principal</div>
      </div>
    </div>
  </body>
  </html>`,
};

const REPORT_MODERN: CardTemplate = {
  key: "REPORT_MODERN",
  name: "Modern Gradient",
  description:
    "Contemporary design with visual grade indicator and clean subject breakdown.",
  thumbnail: "modern",
  htmlContent: `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Report Card — {{examName}}</title>
    ${BASE_PRINT_STYLES}
    <style>
      .card { max-width: 740px; margin: 0 auto; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
      .header { background: linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%); color: #fff; padding: 28px 32px; position: relative; overflow: hidden; }
      .header::before { content: ''; position: absolute; top: -40px; right: -40px; width: 200px; height: 200px; border-radius: 50%; background: rgba(255,255,255,0.08); }
      .header-inner { position: relative; display: flex; align-items: center; gap: 20px; }
      .logo-wrap { width: 68px; height: 68px; border-radius: 10px; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .logo-wrap img { width: 100%; height: 100%; object-fit: contain; }
      .school-name { font-size: 20px; font-weight: 800; margin-bottom: 3px; }
      .school-sub { font-size: 13px; opacity: 0.82; }
      .report-badge { background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); border-radius: 20px; padding: 4px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; display: inline-block; margin-top: 8px; }
      .exam-strip { background: #eff6ff; padding: 14px 32px; border-bottom: 1px solid #bfdbfe; display: flex; justify-content: space-between; align-items: center; }
      .exam-strip .name { font-size: 17px; font-weight: 800; color: #1d4ed8; }
      .exam-strip .date { font-size: 12px; color: #64748b; }
      .body { padding: 28px 32px; }
      .info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 28px; }
      .info-card { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 14px; }
      .info-card .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #0284c7; margin-bottom: 4px; }
      .info-card .value { font-size: 15px; font-weight: 700; color: #0c4a6e; }
      .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #0284c7; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
      .section-title::after { content: ''; flex: 1; height: 1px; background: linear-gradient(to right, #bae6fd, transparent); }
      table th { background: linear-gradient(135deg, #0ea5e9, #2563eb); color: #fff; border-color: #2563eb; }
      table tr:nth-child(even) td { background: #f0f9ff; }
      td { border-color: #bfdbfe; }
      .score-band { margin-top: 24px; background: linear-gradient(135deg, #0ea5e9, #2563eb); border-radius: 10px; padding: 20px 24px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; text-align: center; color: #fff; }
      .score-item { padding: 0 12px; }
      .score-item:not(:last-child) { border-right: 1px solid rgba(255,255,255,0.2); }
      .score-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.8; margin-bottom: 6px; }
      .score-val { font-size: 22px; font-weight: 800; }
      .score-sub { font-size: 11px; opacity: 0.75; margin-top: 2px; }
      .footer { padding: 16px 32px; background: #f0f9ff; border-top: 1px solid #bfdbfe; display: flex; justify-content: space-between; align-items: center; }
      .footer-note { font-size: 11px; color: #94a3b8; }
      .sig-line { border-top: 1.5px solid #2563eb; width: 140px; padding-top: 6px; text-align: center; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #2563eb; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <div class="header-inner">
          <div class="logo-wrap">
            {{#if schoolLogo}}<img src="{{schoolLogo}}" alt="Logo" />{{/if}}
          </div>
          <div>
            <div class="school-name">{{schoolName}}</div>
            <div class="school-sub">Academic Year {{academicYear}}</div>
            <div class="report-badge">📊 Report Card</div>
          </div>
        </div>
      </div>
      <div class="exam-strip">
        <span class="name">{{examName}}</span>
        <span class="date">{{currentDate}}</span>
      </div>
      <div class="body">
        <div class="info-grid">
          <div class="info-card">
            <div class="label">Student Name</div>
            <div class="value">{{studentName}}</div>
          </div>
          <div class="info-card">
            <div class="label">Roll Number</div>
            <div class="value">{{rollNumber}}</div>
          </div>
          <div class="info-card">
            <div class="label">Class</div>
            <div class="value">{{className}}</div>
          </div>
          <div class="info-card">
            <div class="label">Section</div>
            <div class="value">{{sectionName}}</div>
          </div>
        </div>
        <div class="section-title">Marks Statement</div>
        {{marksTable}}
        <div class="score-band">
          <div class="score-item">
            <div class="score-label">Percentage</div>
            <div class="score-val">{{percentage}}%</div>
          </div>
          <div class="score-item">
            <div class="score-label">Total</div>
            <div class="score-val">{{totalObtained}}/{{totalMax}}</div>
          </div>
          <div class="score-item">
            <div class="score-label">Grade</div>
            <div class="score-val">{{gradeLabel}}</div>
          </div>
          <div class="score-item">
            <div class="score-label">Result</div>
            <div class="score-val">{{passStatus}}</div>
          </div>
        </div>
      </div>
      <div class="footer">
        <span class="footer-note">This report card is computer generated.</span>
        <div class="sig-line">Class Teacher / Principal</div>
      </div>
    </div>
  </body>
  </html>`,
};

const REPORT_MINIMAL: CardTemplate = {
  key: "REPORT_MINIMAL",
  name: "Clean Minimal",
  description: "Ultra-clean typographic layout with elegant result summary.",
  thumbnail: "minimal",
  htmlContent: `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Report Card — {{examName}}</title>
    ${BASE_PRINT_STYLES}
    <style>
      .card { max-width: 700px; margin: 0 auto; padding: 40px; }
      .top-rule { height: 4px; background: #0f172a; margin-bottom: 32px; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
      .school-block h1 { font-size: 24px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; margin-bottom: 3px; }
      .school-block p { font-size: 13px; color: #64748b; }
      .report-tag { background: #0f172a; color: #fff; padding: 6px 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; align-self: flex-start; }
      .exam-name { font-size: 19px; font-weight: 800; color: #0f172a; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; }
      .info-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin-bottom: 32px; border: 1px solid #e2e8f0; }
      .info-cell { padding: 14px 16px; border-right: 1px solid #e2e8f0; }
      .info-cell:last-child { border-right: none; }
      .info-cell .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 5px; }
      .info-cell .value { font-size: 14px; font-weight: 700; color: #0f172a; }
      .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 12px; }
      table th { background: #f8fafc; color: #475569; border-color: #e2e8f0; }
      table td { border-color: #e2e8f0; }
      .result-strip { margin-top: 24px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border: 1px solid #0f172a; }
      .r-cell { padding: 16px; border-right: 1px solid #0f172a; }
      .r-cell:last-child { border-right: none; }
      .r-cell .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 5px; }
      .r-cell .val { font-size: 20px; font-weight: 800; color: #0f172a; }
      .r-cell.highlight { background: #0f172a; }
      .r-cell.highlight .label { color: rgba(255,255,255,0.6); }
      .r-cell.highlight .val { color: #fff; font-size: 22px; }
      .bottom { margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end; }
      .note { font-size: 11px; color: #94a3b8; max-width: 300px; line-height: 1.6; }
      .sig-line { border-top: 1px solid #0f172a; width: 150px; padding-top: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; text-align: center; }
      .bottom-rule { height: 4px; background: #0f172a; margin-top: 32px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="top-rule"></div>
      <div class="header">
        <div class="school-block">
          <h1>{{schoolName}}</h1>
          <p>Academic Year {{academicYear}} · Report Card</p>
        </div>
        <div class="report-tag">Report Card</div>
      </div>
      <div class="exam-name">{{examName}}</div>
      <div class="info-row">
        <div class="info-cell">
          <div class="label">Student Name</div>
          <div class="value">{{studentName}}</div>
        </div>
        <div class="info-cell">
          <div class="label">Class &amp; Section</div>
          <div class="value">{{className}} – {{sectionName}}</div>
        </div>
        <div class="info-cell">
          <div class="label">Roll No.</div>
          <div class="value">{{rollNumber}}</div>
        </div>
      </div>
      <div class="section-title">Marks Statement</div>
      {{marksTable}}
      <div class="result-strip">
        <div class="r-cell highlight">
          <div class="label">Percentage</div>
          <div class="val">{{percentage}}%</div>
        </div>
        <div class="r-cell">
          <div class="label">Marks</div>
          <div class="val">{{totalObtained}}/{{totalMax}}</div>
        </div>
        <div class="r-cell">
          <div class="label">Grade</div>
          <div class="val">{{gradeLabel}}</div>
        </div>
        <div class="r-cell">
          <div class="label">Result</div>
          <div class="val">{{passStatus}}</div>
        </div>
      </div>
      <div class="bottom">
        <p class="note">This report card is issued by {{schoolName}} on {{currentDate}}.</p>
        <div class="sig-line">Class Teacher / Principal</div>
      </div>
      <div class="bottom-rule"></div>
    </div>
  </body>
  </html>`,
};

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE REGISTRIES
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIT_CARD_TEMPLATES: Record<string, CardTemplate> = {
  ADMIT_CLASSIC,
  ADMIT_MODERN,
  ADMIT_MINIMAL,
};

export const REPORT_CARD_TEMPLATES: Record<string, CardTemplate> = {
  REPORT_CLASSIC,
  REPORT_MODERN,
  REPORT_MINIMAL,
};

export const DEFAULT_ADMIT_TEMPLATE_KEY = "ADMIT_CLASSIC";
export const DEFAULT_REPORT_TEMPLATE_KEY = "REPORT_CLASSIC";

export function getAdmitTemplate(key: string): CardTemplate {
  return (
    ADMIT_CARD_TEMPLATES[key] ??
    ADMIT_CARD_TEMPLATES[DEFAULT_ADMIT_TEMPLATE_KEY]
  );
}

export function getReportTemplate(key: string): CardTemplate {
  return (
    REPORT_CARD_TEMPLATES[key] ??
    REPORT_CARD_TEMPLATES[DEFAULT_REPORT_TEMPLATE_KEY]
  );
}

// Returns metadata only (no htmlContent) — for the template picker UI
export function getTemplatesMeta(type: "ADMIT_CARD" | "REPORT_CARD") {
  const registry =
    type === "ADMIT_CARD" ? ADMIT_CARD_TEMPLATES : REPORT_CARD_TEMPLATES;
  return Object.values(registry).map(
    ({ key, name, description, thumbnail }) => ({
      key,
      name,
      description,
      thumbnail,
    })
  );
}
