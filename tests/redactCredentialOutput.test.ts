import { describe, expect, it } from 'vitest';
import { redactText } from '../src/main/redact';

describe('credential evidence redaction', () => {
  it('preserves a file reference but masks the extracted value', () => {
    const output = redactText('1. D:\\German Wallet\\keys.txt -> raw-secret-value');
    expect(output).toContain('D:\\German Wallet\\keys.txt');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('raw-secret-value');
  });

  it('masks common credential assignments', () => {
    const output = redactText('api_key=private-value password: another-private-value');
    expect(output).not.toContain('private-value');
    expect(output).toContain('[redacted]');
  });

  it('masks provider token shapes and private key blocks', () => {
    const output = redactText('ghp_123456789012345678901234567890123456\\n-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----');
    expect(output).not.toContain('ghp_');
    expect(output).not.toContain('secret');
    expect(output).toContain('[private-key-redacted]');
  });
});
