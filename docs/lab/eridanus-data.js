// J2000 equatorial coordinates and visual magnitudes for the 31-star Eridanus figure.
// Coordinates are sourced from the Hipparcos-based public star catalogue; the
// explicit topology follows the modern Western constellation figure and adds
// the documented northern and Zaurak river branches.
export const ERIDANUS_STARS = [
  {id:7588,name:'Achernar',designation:'α Eridani',ra:1.62854,dec:-57.2367,mag:.45,bv:-.16},
  {id:9007,name:'Chi',designation:'χ Eridani',ra:1.93245,dec:-51.6096,mag:3.69,bv:.72},
  {id:10602,name:'Phi',designation:'φ Eridani',ra:2.27514,dec:-51.5121,mag:3.56,bv:-.10},
  {id:11407,name:'Kappa',designation:'κ Eridani',ra:2.44975,dec:-47.7038,mag:4.24,bv:-.15},
  {id:12413,name:'HD 16754',designation:'s Eridani',ra:2.66331,dec:-42.8916,mag:4.74,bv:.05},
  {id:12486,name:'Iota',designation:'ι Eridani',ra:2.67776,dec:-39.8553,mag:4.11,bv:.98},
  {id:13847,name:'Acamar',designation:'θ¹ Eridani',ra:2.97103,dec:-40.3047,mag:2.88,bv:.13},
  {id:15510,name:'82 G. Eridani',designation:'e Eridani',ra:3.33145,dec:-43.0716,mag:4.26,bv:.75},
  {id:17797,name:'Upsilon 5',designation:'υ⁵ Eridani',ra:3.80995,dec:-37.6201,mag:4.30,bv:.04},
  {id:17874,name:'Upsilon 6',designation:'υ⁶ Eridani',ra:3.82424,dec:-36.2001,mag:4.17,bv:.91},
  {id:20042,name:'Upsilon 4',designation:'υ⁴ Eridani',ra:4.29823,dec:-33.7983,mag:3.55,bv:-.09},
  {id:20535,name:'Upsilon 3',designation:'υ³ Eridani',ra:4.40060,dec:-34.0170,mag:3.97,bv:1.42},
  {id:21393,name:'Upsilon 2',designation:'υ² Eridani',ra:4.59252,dec:-30.5623,mag:3.81,bv:.96},
  {id:17651,name:'Tau 6',designation:'τ⁶ Eridani',ra:3.78083,dec:-23.2484,mag:4.22,bv:.43},
  {id:16611,name:'Tau 5',designation:'τ⁵ Eridani',ra:3.56313,dec:-21.6328,mag:4.26,bv:-.05},
  {id:15474,name:'Tau 4',designation:'τ⁴ Eridani',ra:3.32527,dec:-21.7579,mag:3.70,bv:1.60},
  {id:14146,name:'Tau 3',designation:'τ³ Eridani',ra:3.03989,dec:-23.6243,mag:4.08,bv:.11},
  {id:12843,name:'Tau 1',designation:'τ¹ Eridani',ra:2.75166,dec:-18.5726,mag:4.47,bv:.50},
  {id:13701,name:'Azha',designation:'η Eridani',ra:2.94044,dec:-8.8976,mag:3.89,bv:1.05},
  {id:15197,name:'Zibal',designation:'ζ Eridani',ra:3.26390,dec:-8.8198,mag:4.80,bv:.20},
  {id:16537,name:'Ran',designation:'ε Eridani',ra:3.54901,dec:-9.4583,mag:3.72,bv:.88},
  {id:17378,name:'Rana',designation:'δ Eridani',ra:3.72082,dec:-9.7652,mag:3.52,bv:.92},
  {id:21444,name:'Nu',designation:'ν Eridani',ra:4.60532,dec:-3.3524,mag:3.93,bv:-.20},
  {id:22109,name:'Mu',designation:'μ Eridani',ra:4.75837,dec:-3.2546,mag:4.01,bv:-.15},
  {id:22701,name:'Omega',designation:'ω Eridani',ra:4.88158,dec:-5.4528,mag:4.36,bv:.23},
  {id:23875,name:'Cursa',designation:'β Eridani',ra:5.13084,dec:-5.0863,mag:2.78,bv:.09},
  {id:23972,name:'Lambda',designation:'λ Eridani',ra:5.15244,dec:-8.7541,mag:4.25,bv:-.21},
  {id:21594,name:'Sceptrum',designation:'53 Eridani',ra:4.63635,dec:-14.3036,mag:3.86,bv:1.00},
  {id:19587,name:'Beid',designation:'ο¹ Eridani',ra:4.19776,dec:-6.8378,mag:4.04,bv:.34},
  {id:18543,name:'Zaurak',designation:'γ Eridani',ra:3.96715,dec:-13.5083,mag:2.97,bv:1.59},
  {id:17593,name:'Pi',designation:'π Eridani',ra:3.76903,dec:-12.1017,mag:4.43,bv:1.55}
];

export const ERIDANUS_EDGES = [
  [23875,22701],[22701,22109],[22109,21444],[21444,17378],[17378,16537],[16537,15197],[15197,13701],[13701,12843],
  [12843,14146],[14146,15474],[15474,16611],[16611,17651],[17651,21393],[21393,20535],[20535,20042],[20042,17874],
  [17874,17797],[17797,15510],[15510,13847],[13847,12486],[12486,12413],[12413,11407],[11407,10602],[10602,9007],[9007,7588],
  [23875,23972],[23972,21594],[21444,19587],[19587,18543],[18543,17593],[17593,17378]
];

export const KEY_STARS = [23875,18543,13847,7588];

export function projectEridanus(width=14.8,height=10.4){
  const ra0=3.43*Math.PI/12,dec0=-29*Math.PI/180;
  const raw=ERIDANUS_STARS.map(star=>{
    const ra=star.ra*Math.PI/12,dec=star.dec*Math.PI/180,d=ra-ra0;
    const cosc=Math.sin(dec0)*Math.sin(dec)+Math.cos(dec0)*Math.cos(dec)*Math.cos(d);
    return {star,x:-(Math.cos(dec)*Math.sin(d))/cosc,y:(Math.cos(dec0)*Math.sin(dec)-Math.sin(dec0)*Math.cos(dec)*Math.cos(d))/cosc};
  });
  const minX=Math.min(...raw.map(p=>p.x)),maxX=Math.max(...raw.map(p=>p.x)),minY=Math.min(...raw.map(p=>p.y)),maxY=Math.max(...raw.map(p=>p.y));
  const scale=Math.min(width/(maxX-minX),height/(maxY-minY));
  return raw.map(p=>({...p.star,x:(p.x-(minX+maxX)/2)*scale,y:(p.y-(minY+maxY)/2)*scale,z:0}));
}
