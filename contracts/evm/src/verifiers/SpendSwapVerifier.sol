// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 swap zkey sha256=15a8f1db4af0db4a198dc782cdb07cb8350afc4cc2d1401508e422046b0c8a50
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendSwapVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 7389652505360263513267194177502994748510407788723274322588984139847166315562;
    uint256 constant IC0y = 15667168953153630421963353583362574901369939284135706513543218188810511391681;

    uint256 constant IC1x = 10997254325975336517256485015888663027174358522031293802791744598154692602692;
    uint256 constant IC1y = 5024597931396550892164183575395645200605050413949891429092130284628771295645;

    uint256 constant IC2x = 20982730597763017716196178781922260510640546661326118645713717724817782383204;
    uint256 constant IC2y = 5990781766750826267902550099136259031668540513802744827899093036902104124211;

    uint256 constant IC3x = 6437475098871197563274010403564725004198021644846833040369405837223403312484;
    uint256 constant IC3y = 6973147922797911403304072359853025232871008698738139103597722657658440307278;

    uint256 constant IC4x = 2829857495457194459767640067725572609177125452867510237616343158465765381681;
    uint256 constant IC4y = 11587832578860759484328382990191396648089498460061503082537166745581556391108;

    uint256 constant IC5x = 19699877175158368873209412587408723856996179996694572392220240252070121178663;
    uint256 constant IC5y = 5271642809989753707852818942480936718208701010115393698928984535152541568060;

    uint256 constant IC6x = 19427822907286110936288262800075667522977859889087042751193644142267251945333;
    uint256 constant IC6y = 17987749806094877050967735405678365842168300077252172711968026706326833321342;

    uint256 constant IC7x = 1743381246841355312832629646734773585296828778113944397797768746789640614003;
    uint256 constant IC7y = 18768312818092024999467886007207969009810473041781807155753699839840373550918;

    uint256 constant IC8x = 11269117001533776224733696949258808343821117194642342856089221160569523761961;
    uint256 constant IC8y = 1562132930734618427511794374333938472134270807480945144816455070342330224077;

    uint256 constant IC9x = 1238995535157560740612476912928680366393272324622003946096406075352212514928;
    uint256 constant IC9y = 3959309018788344228486704985861600517378648756135919133481973049820263185833;

    uint256 constant IC10x = 14765798376759500292570805968009897570966823846228723953171352295638898911128;
    uint256 constant IC10y = 21700516299225719828952295199200799282623612011194090534019425350119701222512;

    uint256 constant IC11x = 14035842515951757706293384065587018972880360982114579870226155388601491881349;
    uint256 constant IC11y = 5975949498118501192654109953510879756846600757737215452167231692101332116851;

    uint256 constant IC12x = 14586558308985554433996129762289612729571124306163824847298533733551826583524;
    uint256 constant IC12y = 18673196742572097000494446764762713624728808127655416610270540785431839655499;

    uint256 constant IC13x = 2470105966585054641773743276857879477938587955446363383085905698451227387150;
    uint256 constant IC13y = 13721095684804653172374099579388068411069183581664659214368527979971784566493;

    uint256 constant IC14x = 21352986751208309275141056671368715220042765141858203652954095468985171314830;
    uint256 constant IC14y = 18306081912011097097472644234418907545360824487221129339218343667147729426700;

    uint256 constant IC15x = 8519597827502563749009606722579791948611383741027285109235374032249531638694;
    uint256 constant IC15y = 5622622415972012794629985160686694796233005680646032906175612127552353047464;

    uint256 constant IC16x = 21541665021835686149157753300298481748454723843576314886311639182283820296092;
    uint256 constant IC16y = 856970118743701817527974135616715220894934961225849359861472653345272162871;

    uint256 constant IC17x = 19544776144449606574090013043585159476662208939033972659490683892093936640718;
    uint256 constant IC17y = 4328011859445139755674718835696027850836600426955627046987662750012095239197;

    uint256 constant IC18x = 7397807914194248145397819015378705075075246592793073400290368100095607592728;
    uint256 constant IC18y = 8853084495058196729503344505800146762849028181813528290833969676498676422881;

    uint256 constant IC19x = 11935645586096690415988178805639662926501376799779798662546670465911087375058;
    uint256 constant IC19y = 9872999137797125933042398924942617716277754508136554221476617946138758435958;

    uint256 constant IC20x = 15146507487925138951033580941785444843819630122407546623036691797284935631419;
    uint256 constant IC20y = 13991298417260956987404023592869525678234315502661452267881207087458503702903;

    uint256 constant IC21x = 21252929011852266952088530837146585969998776615325167160337867706015712966680;
    uint256 constant IC21y = 10735955697348788663454053351087324492036208701100942867287012438381794583476;

    uint256 constant IC22x = 13869001202657042579834200116893192756232708955957903287119308246499273131805;
    uint256 constant IC22y = 9612118138350435510920756822188083984686697084504773775901010974319130372264;

    uint256 constant IC23x = 12966218111505699436213042911500700493734759888467067091452243907528055283437;
    uint256 constant IC23y = 17610047541886992890160697370313341703974516837681867074881921266144820141836;

    uint256 constant IC24x = 6513809741379625163258581820275364437540889777265767056474933484354596741700;
    uint256 constant IC24y = 2945665106443593339485653085833830121459122645239931384952278181406331989937;

    uint256 constant IC25x = 7471407755896300177034006562181273740987449772507059277110403273392720295014;
    uint256 constant IC25y = 5514324309468467133062462176958600304957465330528563214890280224893838384760;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
