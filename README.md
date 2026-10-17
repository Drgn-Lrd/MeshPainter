MeshPainter

MeshPainter is a lightweight, browser-based 3D color-mapping utility built specifically for multi-material 3D printing workflows (such as the Snapmaker U1). Designed for complex articulated models like crystal-backed dragons, it solves the tedium of manual slicer painting by offering an intuitive GUI to inspect STL files, isolate repeating geometric structures (like crystals and roses), and batch-assign or randomize colors across similar features.

Key Features

Browser-Based 3D Viewport: Powered by Three.js with full OrbitControls (rotate, pan, zoom) for inspecting complex articulated models from every angle.

Accessible Color Palette: Designed with explicit text labels alongside color swatches to support color vision differences and precise multi-material toolhead mapping.

Smart Pattern Matching: Groups repeating topological features (like center crystals vs. segment-specific smaller roses) to propagate edits across similar geometry.

Batch Application Modes:

Paint Single Element: Target individual mesh sections.

Repeat to All Similar Structures: Propagate a single color pick to all matched geometry clusters instantly.

Randomize Across Palette: Automatically distribute available toolhead colors across matching structures without repeats.

Zero-Install Workflow: Runs entirely client-side inside any modern web browser—no complex Python environments or compiled binaries required.

Getting Started

Download or clone the index.html file into your local workspace.

Open index.html directly in any modern web browser (Chrome, Brave, Firefox, Edge).

Click Upload STL File in the top navigation bar to import your model.

Select your target color from the labeled palette on the left sidebar, choose your application mode, and map your multi-color print!

Built With

HTML5 & Tailwind CSS – Modern, responsive UI layout.

Three.js (r128) – WebGL-based 3D rendering engine.

STLLoader & OrbitControls – Mesh parsing and interactive viewport navigation.
