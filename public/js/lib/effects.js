// Moteur d'animations de scene : flammes, pluie, inondation, vent, plantes,
// confettis, neige, fumee. Rendu sur un canvas superpose au chrono.
//
// Trois exigences ont guide l'ecriture :
//  - le chrono ne doit jamais saccader : le nombre de particules est plafonne
//    et le pas de temps borne, pour qu'un onglet en arriere-plan ne rattrape
//    pas son retard d'un coup ;
//  - l'animation doit rester lisible derriere les chiffres : la plupart des
//    effets se jouent en fond, avec une couche « premier plan » au choix ;
//  - tout doit fonctionner sur fond transparent, pour la fenetre video.

import { EFFECTS } from '../../shared/effects.js';


const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Cree le moteur sur un canvas.
 * @param {HTMLCanvasElement} canvas
 */
export function createEffects(canvas) {
  const ctx = canvas.getContext('2d');
  let particles = [];
  let currentId = null;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let seedPhase = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    width = rect.width;
    height = rect.height;
  }

  function reset(effect, now) {
    particles = [];
    currentId = effect?.id || null;
    lastFrame = now;
    seedPhase = Math.random() * 1000;
    if (effect?.name === 'confetti') {
      burst(effect, now); // les confettis partent d'un coup
      return;
    }
    // Les effets continus sont pre-remplis : quand la regie envoie « Pluie »,
    // il pleut immediatement, au lieu de se remplir depuis le haut de l'ecran.
    const prefill = PREFILL[effect?.name];
    if (prefill) prefill({ width, height, intensity: Math.min(1, Math.max(0, (effect.intensity ?? 60) / 100)) }, particles);
  }

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * Dessine une image de l'animation.
   * @param {object|null} effect { id, name, intensity, startedAt, durationMs, loop, layer }
   * @param {number} now horodatage aligne sur le serveur
   */
  function update(effect, now) {
    if (!effect || !EFFECTS[effect.name]) {
      if (particles.length || currentId) {
        clear();
        particles = [];
        currentId = null;
      }
      return;
    }

    const elapsed = Math.max(0, now - effect.startedAt);
    const duration = Math.max(1, effect.durationMs || 10000);
    const progress = effect.loop ? (elapsed % duration) / duration : Math.min(1, elapsed / duration);
    const finished = !effect.loop && elapsed > duration + 2500; // on laisse les particules mourir
    if (finished) {
      if (particles.length || currentId) {
        clear();
        particles = [];
        currentId = null;
      }
      return;
    }

    resize();
    if (effect.id !== currentId) reset(effect, now);

    // Pas de temps borne : un onglet revenu au premier plan ne doit pas
    // rejouer d'un coup toutes les images qu'il a manquees.
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;

    const intensity = Math.min(1, Math.max(0, (effect.intensity ?? 60) / 100));
    const spawning = effect.loop || elapsed <= duration;

    clear();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const scene = { ctx, width, height, dt, intensity, progress, elapsed, duration, spawning, now, seedPhase };
    DRAW[effect.name](scene, particles);
  }

  function burst(effect, now) {
    const count = Math.round(60 + ((effect.intensity ?? 60) / 100) * 140);
    resize();
    for (let i = 0; i < count; i++) {
      particles.push({
        x: rand(0, width),
        y: rand(-height * 0.2, height * 0.1),
        vx: rand(-60, 60),
        vy: rand(40, 220),
        size: rand(6, 14),
        ratio: rand(0.35, 0.7),
        spin: rand(-6, 6),
        angle: rand(0, Math.PI * 2),
        color: pick(['#ef4444', '#facc15', '#22c55e', '#38bdf8', '#e2ab52', '#f472b6', '#ffffff']),
        life: rand(3, 6),
        age: 0,
      });
    }
  }

  return { update, clear, resize };
}

// ---------------------------------------------------------------------------
// Pre-remplissage : l'etat « regime etabli » de chaque effet continu.
// ---------------------------------------------------------------------------

const PREFILL = {
  rain({ width, height, intensity }, particles) {
    const count = Math.round((60 + intensity * 340) * 0.85);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: rand(-width * 0.2, width * 1.1),
        y: rand(-height * 0.2, height),
        speed: rand(700, 1300) * (0.6 + intensity * 0.6),
        len: rand(12, 34),
        alpha: rand(0.35, 0.8),
      });
    }
  },
  snow({ width, height, intensity }, particles) {
    const count = Math.round((40 + intensity * 260) * 0.85);
    for (let i = 0; i < count; i++) {
      particles.push({
        x: rand(0, width),
        y: rand(0, height),
        r: rand(1.5, 4.5),
        speed: rand(25, 90),
        drift: rand(10, 45),
        phase: rand(0, Math.PI * 2),
        alpha: rand(0.4, 0.95),
      });
    }
  },
  wind({ width, height, intensity }, particles) {
    const count = Math.round((20 + intensity * 90) * 0.8);
    for (let i = 0; i < count; i++) {
      const leaf = Math.random() < 0.35;
      particles.push({
        leaf,
        x: rand(0, width),
        y: rand(0, height),
        speed: (260 + intensity * 900) * rand(0.6, 1.3),
        len: rand(40, 160),
        size: rand(5, 12),
        angle: rand(0, Math.PI * 2),
        spin: rand(-5, 5),
        alpha: rand(0.2, 0.6),
        sway: rand(10, 40),
        phase: rand(0, Math.PI * 2),
      });
    }
  },
  smoke({ width, height, intensity }, particles) {
    const count = Math.round((14 + intensity * 50) * 0.7);
    for (let i = 0; i < count; i++) {
      const life = rand(3, 7);
      particles.push({
        x: rand(0, width),
        y: rand(height * 0.3, height),
        vx: rand(-14, 14),
        vy: -rand(18, 55),
        size: rand(50, 140) * (0.6 + intensity * 0.6),
        life,
        age: rand(0, life * 0.7),
      });
    }
  },
  fire({ width, height, intensity }, particles) {
    const count = Math.round((40 + intensity * 220) * 0.5);
    for (let i = 0; i < count; i++) {
      const life = rand(0.7, 1.7);
      particles.push({
        x: rand(-width * 0.05, width * 1.05),
        y: height - rand(0, height * 0.25),
        vx: rand(-18, 18),
        vy: -rand(70, 190) * (0.6 + intensity * 0.6),
        size: rand(14, 46) * (0.7 + intensity * 0.6),
        life,
        age: rand(0, life * 0.6),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Les effets. Chacun fait vivre le tableau de particules et le dessine.
// ---------------------------------------------------------------------------

const DRAW = {
  fire(scene, particles) {
    const { ctx, width, height, dt, intensity, spawning } = scene;
    const target = Math.round(40 + intensity * 220);
    if (spawning) {
      const toSpawn = Math.min(14, Math.ceil(target * dt * 2.2));
      for (let i = 0; i < toSpawn && particles.length < target; i++) {
        particles.push({
          x: rand(-width * 0.05, width * 1.05),
          y: height + rand(0, 20),
          vx: rand(-18, 18),
          vy: -rand(70, 190) * (0.6 + intensity * 0.6),
          size: rand(14, 46) * (0.7 + intensity * 0.6),
          life: rand(0.7, 1.7),
          age: 0,
        });
      }
    }

    // Lueur a la base : donne du corps au brasier.
    const glow = ctx.createLinearGradient(0, height, 0, height - height * (0.18 + intensity * 0.22));
    glow.addColorStop(0, `rgba(255, 120, 20, ${0.35 * (0.4 + intensity * 0.6)})`);
    glow.addColorStop(1, 'rgba(255, 120, 20, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'lighter';
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vy -= 40 * dt; // l'air chaud accelere vers le haut
      p.vx += Math.sin((p.age + p.x) * 3) * 12 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const k = p.age / p.life;
      const radius = p.size * (1 - k * 0.55);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, `rgba(255, 246, 190, ${0.55 * (1 - k)})`);
      grad.addColorStop(0.4, `rgba(255, 168, 40, ${0.42 * (1 - k)})`);
      grad.addColorStop(1, 'rgba(200, 40, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  },

  rain(scene, particles) {
    const { ctx, width, height, dt, intensity, spawning } = scene;
    const target = Math.round(60 + intensity * 340);
    const slant = 0.18 + intensity * 0.25;
    if (spawning) {
      const toSpawn = Math.min(20, Math.ceil(target * dt * 3));
      for (let i = 0; i < toSpawn && particles.length < target; i++) {
        particles.push({
          x: rand(-width * 0.2, width * 1.1),
          y: rand(-height * 0.3, 0),
          speed: rand(700, 1300) * (0.6 + intensity * 0.6),
          len: rand(12, 34),
          alpha: rand(0.35, 0.8),
        });
      }
    }
    ctx.lineCap = 'round';
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.y += p.speed * dt;
      p.x += p.speed * slant * dt;
      if (p.y > height + p.len) { particles.splice(i, 1); continue; }
      ctx.strokeStyle = `rgba(200, 230, 255, ${p.alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.len * slant, p.y - p.len);
      ctx.stroke();
    }
  },

  flood(scene, particles) {
    const { ctx, width, height, dt, intensity, progress, elapsed } = scene;
    // Le niveau monte pendant la premiere moitie, puis se stabilise.
    const maxLevel = 0.12 + intensity * 0.78;
    const level = Math.min(maxLevel, maxLevel * Math.min(1, progress * 2));
    const surface = height * (1 - level);
    const t = elapsed / 1000;

    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(0, surface);
    for (let x = 0; x <= width; x += 8) {
      const y = surface
        + Math.sin(x / 90 + t * 1.6) * (5 + intensity * 7)
        + Math.sin(x / 37 - t * 2.4) * (3 + intensity * 4);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();

    const water = ctx.createLinearGradient(0, surface, 0, height);
    water.addColorStop(0, 'rgba(56, 160, 220, 0.55)');
    water.addColorStop(1, 'rgba(10, 60, 120, 0.75)');
    ctx.fillStyle = water;
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 240, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Quelques bulles remontent dans la masse d'eau.
    if (particles.length < Math.round(10 + intensity * 40) && level > 0.05) {
      particles.push({ x: rand(0, width), y: height, r: rand(2, 6), speed: rand(30, 90), age: 0, life: rand(1.5, 3.5) });
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      p.y -= p.speed * dt;
      if (p.age >= p.life || p.y < surface) { particles.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(220, 245, 255, ${0.35 * (1 - p.age / p.life)})`;
      ctx.beginPath();
      ctx.arc(p.x + Math.sin(p.y / 24) * 5, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  wind(scene, particles) {
    const { ctx, width, height, dt, intensity, spawning } = scene;
    const target = Math.round(20 + intensity * 90);
    const speed = 260 + intensity * 900;
    if (spawning) {
      const toSpawn = Math.min(8, Math.ceil(target * dt * 2));
      for (let i = 0; i < toSpawn && particles.length < target; i++) {
        const leaf = Math.random() < 0.35;
        particles.push({
          leaf,
          x: -rand(0, width * 0.4),
          y: rand(0, height),
          speed: speed * rand(0.6, 1.3),
          len: rand(40, 160),
          size: rand(5, 12),
          angle: rand(0, Math.PI * 2),
          spin: rand(-5, 5),
          alpha: rand(0.2, 0.6),
          sway: rand(10, 40),
          phase: rand(0, Math.PI * 2),
        });
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.speed * dt;
      p.phase += dt * 2;
      const y = p.y + Math.sin(p.phase) * p.sway;
      if (p.x - p.len > width) { particles.splice(i, 1); continue; }
      if (p.leaf) {
        p.angle += p.spin * dt;
        ctx.save();
        ctx.translate(p.x, y);
        ctx.rotate(p.angle);
        ctx.fillStyle = `rgba(150, 190, 90, ${p.alpha + 0.25})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.strokeStyle = `rgba(226, 240, 255, ${p.alpha})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(p.x - p.len, y);
        ctx.quadraticCurveTo(p.x - p.len / 2, y - 6, p.x, y);
        ctx.stroke();
      }
    }
  },

  plants(scene, particles) {
    const { ctx, width, height, intensity, progress, elapsed, seedPhase } = scene;
    const stems = Math.round(4 + intensity * 16);
    // Les tiges sont deterministes : toutes les fenetres dessinent la meme
    // vegetation, ce qui compte quand plusieurs ecrans montrent la scene.
    const pseudo = (i, salt) => {
      const v = Math.sin((i + 1) * 12.9898 + salt * 78.233 + seedPhase) * 43758.5453;
      return v - Math.floor(v);
    };
    ctx.lineCap = 'round';
    for (let i = 0; i < stems; i++) {
      const baseX = ((i + 0.5) / stems) * width + (pseudo(i, 1) - 0.5) * (width / stems) * 0.8;
      const maxH = height * (0.25 + pseudo(i, 2) * 0.55) * (0.5 + intensity * 0.7);
      const delay = pseudo(i, 3) * 0.35;
      // La pousse s'acheve aux deux tiers de la duree : le reste du temps, la
      // vegetation est en place et ondule, ce qui se lit mieux de loin.
      const grow = Math.max(0, Math.min(1, (progress - delay) / Math.max(0.15, 0.7 - delay)));
      if (grow <= 0) continue;
      const h = maxH * grow;
      const sway = Math.sin(elapsed / 900 + i) * (4 + intensity * 6);

      ctx.strokeStyle = 'rgba(86, 160, 72, 0.9)';
      ctx.lineWidth = 3 + pseudo(i, 4) * 3;
      ctx.beginPath();
      ctx.moveTo(baseX, height);
      ctx.quadraticCurveTo(baseX + sway, height - h * 0.55, baseX + sway * 1.6, height - h);
      ctx.stroke();

      // Feuilles reparties le long de la tige.
      const leaves = Math.round(2 + pseudo(i, 5) * 4);
      for (let l = 1; l <= leaves; l++) {
        const at = l / (leaves + 1);
        if (grow < at) continue;
        const ly = height - h * at;
        const lx = baseX + sway * at * 1.6;
        const side = l % 2 === 0 ? 1 : -1;
        const size = (8 + pseudo(i, 6 + l) * 12) * (0.6 + intensity * 0.6);
        ctx.fillStyle = `rgba(${100 + Math.round(pseudo(i, 7 + l) * 40)}, ${180 + Math.round(pseudo(i, 8 + l) * 40)}, 90, .85)`;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(side * (0.5 + pseudo(i, 9 + l) * 0.5));
        ctx.beginPath();
        ctx.ellipse(side * size * 0.6, 0, size, size * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Une fleur au sommet, quand la tige est finie.
      if (grow > 0.97 && pseudo(i, 20) > 0.55) {
        const fx = baseX + sway * 1.6;
        const fy = height - h;
        ctx.fillStyle = pseudo(i, 21) > 0.5 ? 'rgba(244, 114, 182, .9)' : 'rgba(226, 171, 82, .9)';
        for (let petal = 0; petal < 5; petal++) {
          const a = (petal / 5) * Math.PI * 2 + elapsed / 4000;
          ctx.beginPath();
          ctx.ellipse(fx + Math.cos(a) * 7, fy + Math.sin(a) * 7, 6, 4, a, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  },

  confetti(scene, particles) {
    const { ctx, width, height, dt } = scene;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      p.vy += 220 * dt; // gravite
      p.vx *= 0.995;
      p.x += p.vx * dt + Math.sin(p.age * 6 + p.angle) * 18 * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      if (p.y > height + 40 || p.age > p.life) { particles.splice(i, 1); continue; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.globalAlpha = Math.max(0, Math.min(1, (p.life - p.age) / 1.2));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, (-p.size * p.ratio) / 2, p.size, p.size * p.ratio);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (particles.length === 0) ctx.clearRect(0, 0, width, height);
  },

  snow(scene, particles) {
    const { ctx, width, height, dt, intensity, spawning, elapsed } = scene;
    const target = Math.round(40 + intensity * 260);
    if (spawning) {
      const toSpawn = Math.min(10, Math.ceil(target * dt * 2));
      for (let i = 0; i < toSpawn && particles.length < target; i++) {
        particles.push({
          x: rand(0, width),
          y: rand(-height * 0.2, 0),
          r: rand(1.5, 4.5),
          speed: rand(25, 90),
          drift: rand(10, 45),
          phase: rand(0, Math.PI * 2),
          alpha: rand(0.4, 0.95),
        });
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.y += p.speed * dt;
      if (p.y > height + 6) { particles.splice(i, 1); continue; }
      const x = p.x + Math.sin(elapsed / 1000 + p.phase) * p.drift;
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.beginPath();
      ctx.arc(x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  smoke(scene, particles) {
    const { ctx, width, height, dt, intensity, spawning } = scene;
    const target = Math.round(14 + intensity * 50);
    if (spawning) {
      const toSpawn = Math.min(4, Math.ceil(target * dt * 1.2));
      for (let i = 0; i < toSpawn && particles.length < target; i++) {
        particles.push({
          x: rand(0, width),
          y: height + rand(0, 40),
          vx: rand(-14, 14),
          vy: -rand(18, 55),
          size: rand(50, 140) * (0.6 + intensity * 0.6),
          life: rand(3, 7),
          age: 0,
        });
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.age / p.life;
      const radius = p.size * (0.5 + k);
      const alpha = 0.22 * Math.sin(Math.PI * k);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, `rgba(190, 195, 205, ${alpha})`);
      grad.addColorStop(1, 'rgba(120, 125, 135, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};
