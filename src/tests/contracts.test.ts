import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { buildContractValidator, SUPPORTED_CONTRACTS } from '../contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(here, '..', '..', 'contracts');

describe('buildContractValidator', () => {
  const validator = buildContractValidator(CONTRACTS_DIR);

  it('lists the two supported contract ids', () => {
    expect(SUPPORTED_CONTRACTS).toEqual(['web.search.v1', 'web.fetch.v1']);
  });

  it('accepts a valid web.search.v1 envelope', () => {
    const envelope = {
      contract_id: 'web.search.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      dedupe_key: 'sha256:abcdef',
      source_ref: 'task:12345',
      caller_agent_id: 'chief-of-staff',
      query: 'london borough tax band',
      top_n: 5,
    };
    const result = validator.validate(envelope);
    expect(result.ok).toBe(true);
  });

  it('accepts a valid web.fetch.v1 envelope', () => {
    const envelope = {
      contract_id: 'web.fetch.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      dedupe_key: 'sha256:fedcba',
      source_ref: 'task:67890',
      caller_agent_id: 'chief-of-staff',
      url: 'https://www.gov.uk/council-tax-bands',
    };
    const result = validator.validate(envelope);
    expect(result.ok).toBe(true);
  });

  it('rejects an envelope with an unknown contract_id', () => {
    const result = validator.validate({ contract_id: 'web.unknown.v1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toMatch(/unknown contract_id/);
  });

  it('rejects a non-object envelope', () => {
    const result = validator.validate('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toMatch(/not an object/);
  });

  it('rejects an envelope missing required fields', () => {
    const result = validator.validate({
      contract_id: 'web.search.v1',
      trace_id: '01234567-89ab-7cde-8f01-23456789abcd',
      // missing dedupe_key, source_ref, caller_agent_id, query
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an envelope with a non-string contract_id', () => {
    const result = validator.validate({ contract_id: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toMatch(/contract_id/);
  });

  it('rejects an envelope with a malformed trace_id', () => {
    const result = validator.validate({
      contract_id: 'web.fetch.v1',
      trace_id: 'not-a-uuid',
      dedupe_key: 'x',
      source_ref: 'x',
      caller_agent_id: 'x',
      url: 'https://www.gov.uk/x',
    });
    expect(result.ok).toBe(false);
  });
});
