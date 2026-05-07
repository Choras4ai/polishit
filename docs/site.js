const revealNodes = document.querySelectorAll('.reveal');
const stepNodes = Array.from(document.querySelectorAll('.story-step'));
const productStage = document.getElementById('productStage');
const heroShell = document.getElementById('heroShell');
const sceneOrder = ['select', 'toolbar', 'polish', 'deai'];

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, {
  threshold: 0.18,
});

revealNodes.forEach((node) => revealObserver.observe(node));

function applyScene(scene) {
  if (productStage) {
    productStage.dataset.scene = scene;
  }
  if (heroShell) {
    heroShell.dataset.scene = scene === 'select' ? 'toolbar' : scene;
  }
  stepNodes.forEach((node) => {
    node.classList.toggle('is-active', node.dataset.sceneTarget === scene);
  });
}

let activeSceneIndex = 2;
let stageTimer = null;

function startStoryLoop() {
  clearInterval(stageTimer);
  applyScene(sceneOrder[activeSceneIndex]);
  stageTimer = setInterval(() => {
    activeSceneIndex = (activeSceneIndex + 1) % sceneOrder.length;
    applyScene(sceneOrder[activeSceneIndex]);
  }, 2400);
}

const storyObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    startStoryLoop();
  });
}, {
  threshold: 0.35,
});

if (productStage) {
  storyObserver.observe(productStage);
}

stepNodes.forEach((node) => {
  node.addEventListener('mouseenter', () => {
    const nextScene = node.dataset.sceneTarget;
    const index = sceneOrder.indexOf(nextScene);
    if (index !== -1) {
      activeSceneIndex = index;
      applyScene(nextScene);
    }
  });
});

startStoryLoop();
