// person/curp.js

const estados = [
  "AS","BC","BS","CC","CL","CM","CS","CH",
  "DF","DG","GT","GR","HG","JC","MC","MN",
  "MS","NT","NL","OC","PL","QT","QR","SP",
  "SL","SR","TC","TS","TL","VZ","YN","ZS"
];

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function limpiar(texto) {
  return texto
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-ZÑ]/g, "");
}

function vocalInterna(texto) {
  return texto.slice(1).match(/[AEIOU]/)?.[0] || "X";
}

function consonanteInterna(texto) {
  return texto
    .slice(1)
    .match(/[BCDFGHJKLMNÑPQRSTVWXYZ]/)?.[0] || "X";
}

function randomDate() {
  const year = Math.floor(Math.random() * 30) + 1970;
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function curp(data = {}) {

  const nombres = limpiar(
    data.nombres || randomItem(["JUAN", "MARIA", "CARLOS", "ANA"])
  );

  const apellidoPaterno = limpiar(
    data.apellidoPaterno || randomItem(["PEREZ", "LOPEZ", "GARCIA"])
  );

  const apellidoMaterno = limpiar(
    data.apellidoMaterno || randomItem(["MARTINEZ", "SANCHEZ", "RAMIREZ"])
  );

  const sexo = data.sexo || randomItem(["H", "M"]);

  const estado = data.estado || randomItem(estados);

  const fechaNacimiento = data.fechaNacimiento || randomDate();

  const fecha = new Date(fechaNacimiento);

  const yy = String(fecha.getFullYear()).slice(-2);
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const dd = String(fecha.getDate()).padStart(2, "0");

  return (
    apellidoPaterno[0] +
    vocalInterna(apellidoPaterno) +
    apellidoMaterno[0] +
    nombres[0] +
    yy +
    mm +
    dd +
    sexo +
    estado +
    consonanteInterna(apellidoPaterno) +
    consonanteInterna(apellidoMaterno) +
    consonanteInterna(nombres) +
    "A0"
  );
}