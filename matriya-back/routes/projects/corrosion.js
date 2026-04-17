import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '../../projects/corrosion-shield/project-spec.json');

function loadSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

const FORMULATIONS = [
  {
    id: 'GALVANIC_BARRIER',
    name: 'Galvanic Barrier',
    description: 'Isolates dissimilar metals to prevent galvanic coupling and electrochemical corrosion.',
    mechanisms: ['galvanic'],
    compatible_metals: ['steel', 'aluminum', 'stainless'],
    target_standard: 'ISO_12944',
    status: 'VALIDATED',
    Es_score: 0.87,
  },
  {
    id: 'SMART_INTERFACE',
    name: 'Smart Interface',
    description: 'pH-responsive coating that activates inhibitor release upon detection of corrosive ions.',
    mechanisms: ['oxidation', 'crevice'],
    compatible_metals: ['steel', 'copper', 'stainless'],
    target_standard: 'ASTM_B117',
    status: 'IN_REVIEW',
    Es_score: 0.74,
  },
  {
    id: 'BIMETALLIC_SEAL',
    name: 'Bimetallic Seal',
    description: 'Physical sealant layer applied at bimetallic junctions to eliminate electrolyte bridging.',
    mechanisms: ['galvanic', 'crevice'],
    compatible_metals: ['aluminum', 'copper', 'stainless'],
    target_standard: 'ISO_12944',
    status: 'VALIDATED',
    Es_score: 0.81,
  },
];

// GET /api/projects/corrosion-shield
router.get('/', (req, res) => {
  try {
    const spec = loadSpec();
    res.json(spec);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load project spec', detail: e.message });
  }
});

// GET /api/projects/corrosion-shield/formulations
router.get('/formulations', (req, res) => {
  res.json({
    project_id: 'CORR-001',
    count: FORMULATIONS.length,
    formulations: FORMULATIONS,
  });
});

export default router;
