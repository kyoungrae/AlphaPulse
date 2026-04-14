import fs from 'fs'
import { homedir } from 'os'
import path from 'path'
import admin from 'firebase-admin'

/** .env 값에 흔한 따옴표 제거, ~ 를 홈 디렉터리로 확장 */
export function expandCredentialPath(raw: string): string {
  let p = raw.trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim()
  }
  if (p.startsWith('~')) {
    p = path.join(homedir(), p.slice(1).replace(/^\/+/, ''))
  }
  return p
}

export function resolveAbsoluteCredentialPath(raw: string): string {
  const expanded = expandCredentialPath(raw)
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded)
}

/**
 * FIREBASE_SERVICE_ACCOUNT_JSON: JSON 문자열이거나, 파일 경로(`{` 로 시작하지 않으면 파일로 읽음)
 */
export function loadInlineOrPathJsonString(): string | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!raw) return null
  const t = expandCredentialPath(raw)
  if (t.startsWith('{')) return t
  const abs = resolveAbsoluteCredentialPath(raw)
  if (fs.existsSync(abs)) {
    return fs.readFileSync(abs, 'utf8')
  }
  return null
}

const PATH_ENV_KEYS = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_SERVICE_ACCOUNT_KEY_PATH',
  'FIREBASE_SERVICE_ACCOUNT_PATH',
] as const

const DEFAULT_KEY_FILENAMES = ['firebase-adminsdk.json', 'serviceAccount.json', 'firebase-service-account.json']

/** 서비스 계정 JSON 파일의 절대 경로 (없으면 null) */
export function findServiceAccountKeyFilePath(): string | null {
  for (const key of PATH_ENV_KEYS) {
    const raw = process.env[key]
    if (!raw) continue
    const abs = resolveAbsoluteCredentialPath(raw)
    if (fs.existsSync(abs)) return abs
  }
  for (const name of DEFAULT_KEY_FILENAMES) {
    const abs = path.resolve(process.cwd(), name)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

/** Express/백필 공통: 인증 정보가 있으면 ServiceAccount 객체, 없으면 null */
export function readServiceAccountCredential(): admin.ServiceAccount | null {
  const inline = loadInlineOrPathJsonString()
  if (inline) {
    try {
      return JSON.parse(inline) as admin.ServiceAccount
    } catch {
      /* JSON 파싱 실패 시 파일 경로로 재시도 */
    }
  }
  const filePath = findServiceAccountKeyFilePath()
  if (filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as admin.ServiceAccount
    } catch {
      return null
    }
  }
  return null
}

/** 백필 스크립트용 실패 시 로그 (값 일부만) */
export function credentialEnvDiagnostics(): string {
  const lines: string[] = []
  for (const key of PATH_ENV_KEYS) {
    const raw = process.env[key]
    if (!raw) continue
    const abs = resolveAbsoluteCredentialPath(raw)
    lines.push(`${key}: 확인 경로=${abs} → 파일 ${fs.existsSync(abs) ? '있음' : '없음'}`)
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const j = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const preview = j.trim().startsWith('{')
      ? `JSON 앞부분 ${j.slice(0, 24)}...`
      : `경로로 처리 시도 → ${resolveAbsoluteCredentialPath(j)}`
    lines.push(`FIREBASE_SERVICE_ACCOUNT_JSON: ${preview}`)
  }
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    lines.push(`GOOGLE_CLOUD_PROJECT=${process.env.GOOGLE_CLOUD_PROJECT}`)
  }
  return lines.length > 0
    ? lines.join('\n')
    : 'Firebase 인증 관련 env 가 비어 있음 (GOOGLE_APPLICATION_CREDENTIALS 등 미설정)'
}
