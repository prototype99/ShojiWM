uniform float tint_phase;

vec3 grade(vec3 color, vec3 tint) {
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 lifted = mix(color, vec3(luma), 0.12);
    vec3 tinted = lifted * tint + tint * 0.08;
    return mix(color, tinted, 0.42);
}

vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 source = texture2D(tex, uv);
    vec3 cool = vec3(0.70, 0.92, 1.22);
    vec3 warm = vec3(1.25, 0.82, 0.72);
    vec3 tint = tint_phase > 0.5 ? warm : cool;

    return vec4(grade(source.rgb, tint), source.a);
}
