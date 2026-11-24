
      uniform float uTime;
      uniform vec3 uColor;
      varying vec3 vNormal;
      void main() {
        float rim = pow(1.0 - abs(vNormal.z), 2.0);
        float pulse = 0.5 + 0.5 * sin(uTime * 2.0);
        gl_FragColor = vec4(uColor * (0.6 + rim * pulse), 1.0);
      }
    